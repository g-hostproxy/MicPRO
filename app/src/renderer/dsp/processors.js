/*
 * MicPRO AudioWorklet processors
 *  - micpro-denoise : STFT spectral noise reduction with adaptive noise floor tracking
 *  - micpro-gate    : smooth noise gate / downward expander with hysteresis + hold
 *  - micpro-deesser : split-band de-esser (only the sibilant band is turned down)
 *  - micpro-recorder: streams PCM blocks back to the main thread
 *
 * Everything here runs on the real-time audio thread: no allocation in process().
 */

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (lin) => 20 * Math.log10(Math.max(lin, 1e-9));
const timeCoef = (ms, sr) => Math.exp(-1 / Math.max(1e-6, (ms / 1000) * sr));

/* ------------------------------------------------------------------ */
/* Spectral denoiser                                                   */
/* ------------------------------------------------------------------ */

class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
      this.rev[i] = r;
    }
  }
  // in-place complex transform; inverse=true gives unscaled inverse
  transform(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const c = this.cos[k], s = sign * this.sin[k];
          const tr = re[b] * c + im[b] * s;
          const ti = -re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

class DenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 512;           // ~10.7 ms frame at 48 kHz
    this.H = this.N / 2;    // 50% overlap
    this.bins = this.N / 2 + 1;
    this.fft = new FFT(this.N);
    // sqrt-Hann analysis + synthesis => Hann^2 sums to 1 at 50% overlap
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N));

    this.inBuf = new Float32Array(this.N);   // sliding analysis window
    this.outBuf = new Float32Array(this.N);  // overlap-add accumulator
    this.fill = 0;                           // samples gathered since last hop
    this.outQueue = new Float32Array(this.N * 2);
    this.qRead = 0; this.qWrite = this.H;    // H samples of latency pre-filled with silence
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);

    this.psd = new Float32Array(this.bins);    // smoothed signal power
    this.noise = new Float32Array(this.bins);  // tracked noise power
    this.gain = new Float32Array(this.bins).fill(1);
    this.tmpGain = new Float32Array(this.bins);
    this.learned = null;                       // optional captured noise profile
    this.learnFrames = 0; this.learnAcc = null;
    this.frames = 0;

    this.enabled = true;
    this.strength = 0.6;    // 0..1
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
      if (typeof d.strength === 'number') this.strength = Math.min(1, Math.max(0, d.strength));
      if (d.learn) { this.learnFrames = Math.round((d.learn * sampleRate) / this.H); this.learnAcc = new Float32Array(this.bins); this.learnTotal = this.learnFrames; }
      if (d.clearProfile) this.learned = null;
    };
  }

  processFrame() {
    const N = this.N, re = this.re, im = this.im, win = this.win;
    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * win[i]; im[i] = 0; }
    this.fft.transform(re, im, false);

    const bins = this.bins;
    this.frames++;
    const rise = 1.0025;   // noise floor may climb ~ +4.7 dB/s (slowly adapts to new fans etc.)
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-12;
      this.psd[k] = this.frames === 1 ? p : 0.7 * this.psd[k] + 0.3 * p;
      const s = this.psd[k];
      if (this.frames < 20) this.noise[k] = this.frames === 1 ? s : Math.min(this.noise[k] * 1.05, s * 2 + this.noise[k] * 0.5);
      else if (s < this.noise[k]) this.noise[k] = 0.85 * this.noise[k] + 0.15 * s;
      else this.noise[k] *= rise;
      if (this.learnFrames > 0) this.learnAcc[k] += p;
    }
    if (this.learnFrames > 0) {
      this.learnFrames--;
      if (this.learnFrames === 0) {
        this.learned = new Float32Array(bins);
        for (let k = 0; k < bins; k++) this.learned[k] = this.learnAcc[k] / this.learnTotal;
        this.port.postMessage({ type: 'learned' });
      }
    }

    // Wiener-style suppression gain with over-subtraction and a spectral floor
    const st = this.enabled ? this.strength : 0;
    const over = 1.5 + 3.0 * st;
    const floor = dbToLin(-6 - 24 * st);  // max reduction 6..30 dB
    for (let k = 0; k < bins; k++) {
      let n = this.noise[k] * 1.6;          // min-tracking under-estimates the mean
      if (this.learned) n = Math.max(n, this.learned[k]);
      const snr = this.psd[k] / n;
      let g = 1 - over / Math.max(snr, 1e-6);
      g = g < floor ? floor : g;
      if (st === 0) g = 1;
      this.tmpGain[k] = g;
    }
    // smooth across frequency (reduces "musical noise") and over time (fast open, slower close)
    for (let k = 0; k < bins; k++) {
      const a = this.tmpGain[k > 0 ? k - 1 : 0], b = this.tmpGain[k], c = this.tmpGain[k < bins - 1 ? k + 1 : k];
      const g = 0.25 * a + 0.5 * b + 0.25 * c;
      const prev = this.gain[k];
      this.gain[k] = g > prev ? prev + 0.6 * (g - prev) : prev + 0.25 * (g - prev);
    }
    for (let k = 0; k < bins; k++) {
      const g = this.gain[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    this.fft.transform(re, im, true);
    const inv = 1 / N;
    for (let i = 0; i < N; i++) this.outBuf[i] += re[i] * inv * win[i];

    // first H samples are complete -> push to output queue
    const q = this.outQueue, qn = q.length;
    for (let i = 0; i < this.H; i++) { q[this.qWrite] = this.outBuf[i]; this.qWrite = (this.qWrite + 1) % qn; }
    this.outBuf.copyWithin(0, this.H);
    this.outBuf.fill(0, this.N - this.H);
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const len = out.length;
    if (!input) { out.fill(0); return true; }
    const q = this.outQueue, qn = q.length;
    for (let i = 0; i < len; i++) {
      this.inBuf[this.H + this.fill] = input[i];
      this.fill++;
      if (this.fill === this.H) {
        this.processFrame();
        this.inBuf.copyWithin(0, this.H);
        this.fill = 0;
      }
      out[i] = q[this.qRead];
      this.qRead = (this.qRead + 1) % qn;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Noise gate / expander                                               */
/* ------------------------------------------------------------------ */

class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { enabled: true, threshold: -48, range: -40, attack: 2, hold: 120, release: 160, hysteresis: 5 };
    this.env = 0; this.gain = 1; this.open = false; this.holdLeft = 0;
    this.reportEvery = Math.round(sampleRate / 30); this.sinceReport = 0;
    this.updateCoefs();
    this.port.onmessage = (e) => { Object.assign(this.cfg, e.data || {}); this.updateCoefs(); };
  }
  updateCoefs() {
    const c = this.cfg;
    this.envAtt = timeCoef(0.5, sampleRate);
    this.envRel = timeCoef(40, sampleRate);
    this.gAtt = timeCoef(c.attack, sampleRate);
    this.gRel = timeCoef(c.release, sampleRate);
    this.floor = dbToLin(c.range);
    this.openLin = dbToLin(c.threshold);
    this.closeLin = dbToLin(c.threshold - c.hysteresis);
    this.holdSamples = Math.round((c.hold / 1000) * sampleRate);
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!input) { out.fill(0); return true; }
    const c = this.cfg;
    for (let i = 0; i < out.length; i++) {
      const x = input[i], ax = x < 0 ? -x : x;
      this.env = ax > this.env ? this.envAtt * this.env + (1 - this.envAtt) * ax : this.envRel * this.env + (1 - this.envRel) * ax;
      if (this.env >= this.openLin) { this.open = true; this.holdLeft = this.holdSamples; }
      else if (this.env < this.closeLin) {
        if (this.holdLeft > 0) this.holdLeft--; else this.open = false;
      }
      const target = !c.enabled || this.open ? 1 : this.floor;
      const coef = target > this.gain ? this.gAtt : this.gRel;
      this.gain = coef * this.gain + (1 - coef) * target;
      out[i] = x * this.gain;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    this.sinceReport += out.length;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      this.port.postMessage({ open: this.open || !c.enabled, gr: linToDb(this.gain), env: linToDb(this.env) });
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Split-band de-esser                                                 */
/* ------------------------------------------------------------------ */

class DeesserProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { enabled: true, frequency: 6500, threshold: -30, maxReduction: 10, ratio: 4 };
    this.bx1 = 0; this.bx2 = 0; this.by1 = 0; this.by2 = 0;
    this.hpPrevX = 0; this.hpPrevY = 0;
    this.env = 0; this.gr = 0;
    this.reportEvery = Math.round(sampleRate / 30); this.sinceReport = 0; this.peakGr = 0;
    this.update();
    this.port.onmessage = (e) => { Object.assign(this.cfg, e.data || {}); this.update(); };
  }
  update() {
    const f = Math.min(this.cfg.frequency, sampleRate * 0.45);
    // detector: RBJ band-pass (constant 0 dB peak)
    const w0 = (2 * Math.PI * f) / sampleRate, Q = 1.4;
    const alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0; this.a2 = (1 - alpha) / a0;
    // split: 1st-order high-pass a bit below detector so the whole "s" band is caught
    const fc = f * 0.6, rc = 1 / (2 * Math.PI * fc), dt = 1 / sampleRate;
    this.hpA = rc / (rc + dt);
    this.att = timeCoef(0.8, sampleRate); this.rel = timeCoef(70, sampleRate);
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!input) { out.fill(0); return true; }
    const c = this.cfg;
    for (let i = 0; i < out.length; i++) {
      const x = input[i];
      const bp = this.b0 * x + this.b2 * this.bx2 - this.a1 * this.by1 - this.a2 * this.by2;
      this.bx2 = this.bx1; this.bx1 = x; this.by2 = this.by1; this.by1 = bp;
      const a = bp < 0 ? -bp : bp;
      this.env = a > this.env ? this.att * this.env + (1 - this.att) * a : this.rel * this.env + (1 - this.rel) * a;
      const lvl = linToDb(this.env);
      let grDb = 0;
      if (c.enabled && lvl > c.threshold) grDb = Math.min(c.maxReduction, (lvl - c.threshold) * (1 - 1 / c.ratio));
      const hp = this.hpA * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x; this.hpPrevY = hp;
      const low = x - hp;
      out[i] = low + hp * dbToLin(-grDb);
      if (grDb > this.peakGr) this.peakGr = grDb;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    this.sinceReport += out.length;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      this.port.postMessage({ gr: -this.peakGr });
      this.peakGr = 0;
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Recorder tap                                                        */
/* ------------------------------------------------------------------ */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.block = new Float32Array(4096); this.pos = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.recording = true; this.pos = 0; }
      if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ type: 'stopped' }); }
    };
  }
  flush() {
    if (this.pos > 0) { this.port.postMessage({ type: 'data', samples: this.block.slice(0, this.pos) }); this.pos = 0; }
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
    if (!this.recording || !input) return true;
    for (let i = 0; i < input.length; i++) {
      this.block[this.pos++] = input[i];
      if (this.pos === this.block.length) this.flush();
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Voice changer: two-way radio transmission model                     */
/* ------------------------------------------------------------------ */
/*
 * Models what actually happens on a radio link instead of just EQ'ing the voice:
 *  1. VOX keying: talking keys the transmitter (key-up click + carrier noise),
 *     silence after a hold time un-keys it (optional roger beep + squelch tail "kssh").
 *  2. Transmit chain: band-limit -> fast AGC (handheld radios ride the mic gain hard)
 *     -> over-modulation clipping -> optional codec crush -> tiny-speaker resonance.
 *  3. Channel: hiss that the voice partly "captures" (FM) or sits on top of (AM),
 *     crackle impulses, short signal breakups, slow fading and heterodyne whistle.
 */

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, gainDb = 0) {
    const w0 = (2 * Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
    else if (type === 'lowshelf') {
      const sA = Math.sqrt(A), al = (sw / 2) * Math.SQRT2;
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * sA * al); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - 2 * sA * al);
      a0 = (A + 1) + (A - 1) * cw + 2 * sA * al; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - 2 * sA * al;
    }
    else { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) { // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class VoiceFxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { enabled: false };
    // voice band (4th-order HP + 4th-order LP), speaker resonance, post DC block
    this.vHp = [new Biquad(), new Biquad()]; this.vLp = [new Biquad(), new Biquad()];
    this.vPeak = new Biquad(); this.vPost = new Biquad();
    // noise band
    this.nHp = new Biquad(); this.nLp = [new Biquad(), new Biquad()];
    this.oLp = [new Biquad(), new Biquad()];
    this.seed = 0x2468ace1;
    this.env = 0; this.floor = 0; this.keyed = false; this.holdLeft = 0;
    this.minRing = new Float32Array(Math.ceil(sampleRate / 128)); this.minPos = 0; this.blockMin = 1;
    this.lvl = 1e-4; this.agc = 1; this.vEnv = 0;
    this.keyGain = 0; this.breakGain = 1; this.breakLeft = 0;
    this.crushPhase = 0; this.held = 0;
    this.crackAmp = 0;
    this.clickLeft = 0; this.beepLeft = 0; this.tailLeft = 0; this.tailLen = 1;
    this.beepPhase = 0; this.hetPhase = 0; this.t = 0;
    this.reportedTx = null;
    this.configure({});
    this.port.onmessage = (e) => this.configure(e.data || {});
  }

  configure(d) {
    const p = Object.assign(this.p, d);
    const def = (k, v) => { if (typeof p[k] !== 'number') p[k] = v; };
    def('lowCut', 350); def('highCut', 3000); def('peakFreq', 1800); def('peakGain', 4);
    def('agcTarget', -16); def('agcMax', 22); def('drive', 3); def('asym', 0.15);
    def('crushRate', 0); def('bits', 0); def('hiss', 0.05); def('duck', 0.7);
    def('crackle', 0.2); def('breakup', 0.1); def('fading', 0); def('hetFreq', 0); def('hetLevel', 0);
    def('tailMs', 180); def('tailLevel', 0.3); def('click', 0.5); def('beepF1', 1450); def('beepF2', 1000);
    def('out', 0); def('keyThreshold', -42); def('holdMs', 380);
    this.vHp[0].set('hp', p.lowCut, 0.5412); this.vHp[1].set('hp', p.lowCut, 1.3066);
    this.vLp[0].set('lp', p.highCut, 0.5412); this.vLp[1].set('lp', p.highCut, 1.3066);
    this.vPeak.set('peak', p.peakFreq, 1.1, p.peakGain);
    this.vPost.set('hp', Math.max(60, p.lowCut * 0.6), 0.707);
    this.nHp.set('hp', p.lowCut * 1.2, 0.707);
    this.nLp[0].set('lp', p.highCut * 1.1, 0.5412); this.nLp[1].set('lp', p.highCut * 1.1, 1.3066);
    this.oLp[0].set('lp', p.highCut * 1.3, 0.5412); this.oLp[1].set('lp', p.highCut * 1.3, 1.3066);
    this.keyLin = dbToLin(p.keyThreshold);
    this.holdN = Math.round((p.holdMs / 1000) * sampleRate);
    this.agcTargetLin = dbToLin(p.agcTarget); this.agcMaxLin = dbToLin(p.agcMax);
    this.outLin = dbToLin(p.out);
    this.asymOff = Math.tanh(p.asym);
    this.bitQ = p.bits > 0 ? Math.pow(2, p.bits - 1) : 0;
    this.clickN = Math.round(0.022 * sampleRate);
    this.beepN = Math.round(0.075 * sampleRate);
    this.cEnvA = timeCoef(0.6, sampleRate); this.cEnvR = timeCoef(70, sampleRate);
    this.cLvlA = timeCoef(2, sampleRate); this.cLvlR = timeCoef(140, sampleRate);
    this.cAgcDown = timeCoef(1.5, sampleRate); this.cAgcUp = timeCoef(90, sampleRate);
    this.cKey = timeCoef(2.5, sampleRate); this.cBreak = timeCoef(1.2, sampleRate);
    this.cCrack = Math.exp(-1 / (0.0007 * sampleRate));
    if (!p.enabled) { this.keyed = false; this.clickLeft = this.beepLeft = this.tailLeft = 0; }
  }

  rnd() { // xorshift32, uniform in [-1, 1)
    let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0;
    return (this.seed / 2147483648) - 1;
  }

  keyUp() {
    this.clickLeft = this.clickN;
    this.beepLeft = 0; this.tailLeft = 0;
  }

  keyDown() {
    const p = this.p;
    this.beepLeft = p.beep ? this.beepN * 2 : 0;
    this.tailLen = p.squelch ? Math.max(1, Math.round((p.tailMs / 1000) * sampleRate)) : 0;
    this.tailLeft = this.tailLen;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const p = this.p, sr = sampleRate;
    if (!input) { out.fill(0); return true; }
    if (!p.enabled) { out.set(input); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out); return true; }
    // noise floor = minimum envelope over the last second (one entry per 128-sample block)
    this.minRing[this.minPos] = this.blockMin; this.minPos = (this.minPos + 1) % this.minRing.length; this.blockMin = 1;
    let fl = 1; for (let k = 0; k < this.minRing.length; k++) if (this.minRing[k] < fl) fl = this.minRing[k];
    this.floor = fl;

    for (let i = 0; i < out.length; i++) {
      const x = input[i];
      this.t++;

      /* -------- keying (VOX) -------- */
      const ax = x < 0 ? -x : x;
      this.env = ax > this.env ? this.cEnvA * this.env + (1 - this.cEnvA) * ax : this.cEnvR * this.env + (1 - this.cEnvR) * ax;
      // adaptive threshold: keying needs ~11 dB over the quietest level of the last second,
      // so a noisy room or an open gate can't hold the transmitter open
      if (this.env < this.blockMin) this.blockMin = this.env;
      const thr = Math.min(0.1, Math.max(this.keyLin, this.floor * 3.5));
      if (this.env > thr) {
        if (!this.keyed) this.keyUp();
        this.keyed = true; this.holdLeft = this.holdN;
      } else if (this.keyed && --this.holdLeft <= 0) {
        this.keyed = false; this.keyDown();
      }

      /* -------- transmit chain -------- */
      let v = this.vHp[1].run(this.vHp[0].run(x));
      const av = v < 0 ? -v : v;
      this.lvl = av > this.lvl ? this.cLvlA * this.lvl + (1 - this.cLvlA) * av : this.cLvlR * this.lvl + (1 - this.cLvlR) * av;
      const gT = Math.min(this.agcMaxLin, this.agcTargetLin / Math.max(this.lvl, 1e-6));
      this.agc = gT < this.agc ? this.cAgcDown * this.agc + (1 - this.cAgcDown) * gT : this.cAgcUp * this.agc + (1 - this.cAgcUp) * gT;
      v *= this.agc;
      const vNorm = Math.min(1, (v < 0 ? -v : v) / this.agcTargetLin);
      this.vEnv = vNorm > this.vEnv ? 0.995 * this.vEnv + 0.005 * vNorm : 0.9995 * this.vEnv + 0.0005 * vNorm;
      // over-modulation: driven asymmetric tanh (adds odd + even harmonics like a cheap mic amp)
      v = (Math.tanh(v * p.drive + p.asym) - this.asymOff) / Math.tanh(Math.max(1, p.drive) * 0.5 + 0.5);
      if (p.crushRate > 0) {
        this.crushPhase += p.crushRate / sr;
        if (this.crushPhase >= 1) { this.crushPhase -= 1; this.held = v; }
        v = this.held;
      }
      if (this.bitQ) v = Math.round(v * this.bitQ) / this.bitQ;
      v = this.vLp[1].run(this.vLp[0].run(v));
      v = this.vPost.run(this.vPeak.run(v));
      if (p.fading > 0) {
        const lfo = 0.5 + 0.25 * Math.sin((2 * Math.PI * 0.23 * this.t) / sr) + 0.25 * Math.sin((2 * Math.PI * 0.61 * this.t) / sr);
        v *= 1 - p.fading * lfo * lfo;
      }

      /* -------- channel -------- */
      this.keyGain = this.cKey * this.keyGain + (1 - this.cKey) * (this.keyed ? 1 : 0);
      if (this.keyed && this.breakLeft <= 0 && p.breakup > 0 && Math.random() < p.breakup * 0.00005) {
        this.breakLeft = Math.round((0.02 + Math.random() * 0.07) * sr);
      }
      let breaking = false;
      if (this.breakLeft > 0) { this.breakLeft--; breaking = true; }
      this.breakGain = this.cBreak * this.breakGain + (1 - this.cBreak) * (breaking ? 0.05 : 1);

      // raw noise source that gets band-limited like the voice
      let pre = 0;
      if (this.keyGain > 0.001) {
        const capture = 1 - p.duck * Math.min(1, this.vEnv * 1.6);
        pre += this.rnd() * p.hiss * capture * this.keyGain * (breaking ? 4 : 1);
        if (Math.random() < p.crackle * 0.0007) this.crackAmp = 0.15 + Math.random() * 0.75;
      }
      if (this.crackAmp > 0.001) { pre += this.rnd() * this.crackAmp; this.crackAmp *= this.cCrack; }
      if (this.clickLeft > 0) {
        const k = this.clickLeft / this.clickN; // 1 -> 0
        pre += p.click * (this.rnd() * 0.9 * k * k + (this.clickLeft > this.clickN - 48 ? 0.6 : 0));
        this.clickLeft--;
      }
      let tone = 0;
      if (!this.keyed && this.beepLeft > 0) {
        const f = this.beepLeft > this.beepN ? p.beepF1 : p.beepF2;
        this.beepPhase += f / sr; if (this.beepPhase > 1) this.beepPhase -= 1;
        const posInTone = this.beepLeft > this.beepN ? this.beepLeft - this.beepN : this.beepLeft;
        const edge = Math.min(1, posInTone / 96, (this.beepN - posInTone) / 96);
        tone = Math.tanh(1.5 * Math.sin(2 * Math.PI * this.beepPhase)) * 0.22 * edge;
        this.beepLeft--;
      } else if (!this.keyed && this.tailLeft > 0) {
        // squelch tail: carrier drops, receiver opens on raw noise for a moment, then slams shut
        const pos = this.tailLen - this.tailLeft;
        const a = Math.min(1, pos / (0.002 * sr)), r = Math.min(1, this.tailLeft / (0.008 * sr));
        pre += this.rnd() * p.tailLevel * a * r * 3.2;
        this.tailLeft--;
      }
      let n = this.nLp[1].run(this.nLp[0].run(this.nHp.run(pre)));
      if (p.hetLevel > 0 && this.keyGain > 0.001) {
        this.hetPhase += (p.hetFreq + 18 * Math.sin((2 * Math.PI * 0.09 * this.t) / sr)) / sr;
        if (this.hetPhase > 1) this.hetPhase -= 1;
        n += Math.sin(2 * Math.PI * this.hetPhase) * p.hetLevel * this.keyGain;
      }

      // receiver audio stage: gentle saturation keeps clicks, crackle and tails below full scale
      let y = Math.tanh((v * this.keyGain * this.breakGain + n + tone) * 0.9) * 0.82;
      y = this.oLp[1].run(this.oLp[0].run(y)); // small speaker: nothing survives far above the radio band
      out[i] = y * this.outLin;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    const tx = this.keyed || this.tailLeft > 0 || this.beepLeft > 0;
    if (tx !== this.reportedTx) { this.reportedTx = tx; this.port.postMessage({ tx }); }
    return true;
  }
}


/* ------------------------------------------------------------------ */
/* Pitch + formant shifter (TD-PSOLA)                                  */
/* ------------------------------------------------------------------ */
/*
 * 1. YIN pitch tracking on a 4x decimated copy of the input.
 * 2. Analysis marks are placed one pitch period apart and aligned by cross-correlation,
 *    so every grain starts at the same point of the glottal cycle.
 * 3. Two-period Hann grains are overlap-added at period / pitchRatio spacing -> new pitch.
 * 4. Each grain is resampled by the formant factor while it is copied, which scales the
 *    spectral envelope (vocal tract size) independently of the pitch.
 * Unvoiced sound (s, f, breath) is passed through with fixed 6 ms grains so it isn't buzzed.
 * Fixed latency: 36 ms.
 */
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.SIZE = 16384; this.M = this.SIZE - 1;
    this.inBuf = new Float32Array(this.SIZE); this.outBuf = new Float32Array(this.SIZE);
    this.inPos = 0; this.readPos = 0;
    this.T0max = Math.round(sampleRate / 75);
    this.ffMin = 0.7;
    this.HmaxOut = Math.ceil(this.T0max / this.ffMin);
    this.L = this.HmaxOut + Math.ceil(this.T0max * 1.7) + 128; // ~36 ms at 48 kHz
    this.uvT = Math.round(0.006 * sampleRate);
    // decimated detector
    this.D = 4; this.dRate = sampleRate / this.D;
    this.dSize = 4096; this.dM = this.dSize - 1; this.dBuf = new Float32Array(this.dSize); this.dPos = 0;
    this.dAcc = 0; this.dN = 0; this.lp1 = 0; this.lp2 = 0;
    this.W = Math.round(0.02 * this.dRate);
    this.minLag = Math.floor(this.dRate / 480); this.maxLag = Math.ceil(this.dRate / 75);
    this.win = new Float32Array(this.W + this.maxLag + 2);
    this.d = new Float32Array(this.maxLag + 2);
    this.hist = new Float32Array(1024); // T0 per 128-sample block of input time
    this.sinceDetect = 0; this.lastCenterBlock = 0;
    this.t0Med = [0, 0, 0];
    this.synthPos = 0; this.anaMark = 0; this.lastVoiced = false;
    this.p = { enabled: false, ratio: 1, formant: 1, gain: 1 };
    this.active = false;
    this.port.onmessage = (e) => {
      Object.assign(this.p, e.data || {});
      this.p.formant = Math.max(this.ffMin, Math.min(1.8, this.p.formant || 1));
      this.p.ratio = Math.max(0.25, Math.min(4, this.p.ratio || 1));
    };
  }

  t0At(t) {
    const b = Math.min(t >> 7, this.lastCenterBlock);
    return this.hist[b & 1023];
  }

  detect() {
    const W = this.W, maxLag = this.maxLag, win = this.win, n = W + maxLag;
    const base = this.dPos - n;
    let e = 0;
    for (let j = 0; j < n; j++) { const v = this.dBuf[(base + j) & this.dM]; win[j] = v; if (j < W) e += v * v; }
    let T0 = 0;
    if (Math.sqrt(e / W) > 0.004) { // about -48 dBFS: below that it's room noise, not voice
      const d = this.d;
      for (let tau = 1; tau <= maxLag; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const a = win[j] - win[j + tau]; s += a * a; }
        d[tau] = s;
      }
      // cumulative mean normalised difference
      let run = 0, best = -1, bestV = 1;
      for (let tau = 1; tau <= maxLag; tau++) {
        run += d[tau];
        d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
      }
      for (let tau = this.minLag; tau < maxLag; tau++) {
        if (d[tau] < 0.15) {
          while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
          best = tau; bestV = d[tau]; break;
        }
        if (d[tau] < bestV) { bestV = d[tau]; best = tau; }
      }
      if (best > 0 && bestV < 0.3) {
        let tau = best;
        if (tau > 1 && tau < maxLag) { // parabolic interpolation
          const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
          if (den > 1e-9) tau += (0.5 * (a - c)) / den;
        }
        T0 = tau * this.D;
      }
    }
    // median of 3 removes single-frame octave errors
    this.t0Med.shift(); this.t0Med.push(T0);
    const [a, b, c] = this.t0Med;
    const med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    // the analysis window is centred n/2 decimated samples in the past
    const center = this.inPos - (n / 2) * this.D;
    const cb = Math.max(0, center >> 7);
    for (let blk = this.lastCenterBlock + 1; blk <= cb; blk++) this.hist[blk & 1023] = med;
    this.lastCenterBlock = Math.max(this.lastCenterBlock, cb);
  }

  refine(prev, cand, T0) {
    const R = Math.max(2, Math.round(T0 * 0.12)), half = Math.round(T0 * 0.5), buf = this.inBuf, M = this.M;
    let best = cand, bestV = -Infinity;
    for (let o = -R; o <= R; o++) {
      let s = 0;
      for (let j = -half; j < half; j += 2) s += buf[(prev + j) & M] * buf[(cand + o + j) & M];
      if (s > bestV) { bestV = s; best = cand + o; }
    }
    return best;
  }

  addGrain(aC, sC, H, ff, scale) {
    const Ho = Math.max(2, Math.floor(H / ff)), s0 = Math.round(sC), buf = this.inBuf, out = this.outBuf, M = this.M;
    const k = Math.PI / Ho;
    for (let j = -Ho; j <= Ho; j++) {
      const w = (0.5 + 0.5 * Math.cos(k * j)) * scale;
      const src = aC + j * ff, i0 = Math.floor(src), fr = src - i0;
      const a = buf[i0 & M], b = buf[(i0 + 1) & M];
      out[(s0 + j) & M] += w * (a + (b - a) * fr);
    }
    return Ho;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const n = out.length;
    const x = input || new Float32Array(n);
    const p = this.p;

    for (let i = 0; i < n; i++) {
      const v = x[i];
      this.inBuf[(this.inPos + i) & this.M] = v;
      // 2x one-pole lowpass then decimate by 4 for the pitch detector
      this.lp1 += 0.33 * (v - this.lp1); this.lp2 += 0.33 * (this.lp1 - this.lp2);
      if (++this.dN === this.D) { this.dN = 0; this.dBuf[this.dPos & this.dM] = this.lp2; this.dPos++; }
    }
    this.inPos += n;
    this.sinceDetect += n;
    if (!p.enabled) {
      // when disabled, the sub layer stays silent and the main layer passes through untouched
      if (p.silentWhenOff) out.fill(0); else out.set(x);
      this.active = false; this.readPos += n;
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return true;
    }
    if (this.sinceDetect >= 256) { this.sinceDetect = 0; this.detect(); }
    if (!this.active) {
      this.active = true; this.outBuf.fill(0);
      this.synthPos = this.readPos + this.L; this.lastVoiced = false;
    }

    const ff = p.formant, r = p.ratio;
    while (this.synthPos <= this.readPos + n + this.HmaxOut) {
      const target = Math.round(this.synthPos - this.L);
      let T0 = this.t0At(target);
      let S, H;
      if (T0 > 0) {
        if (!this.lastVoiced) this.anaMark = target;
        else {
          let guard = 0;
          while (this.anaMark + T0 * 0.5 < target && guard++ < 8) this.anaMark = this.refine(this.anaMark, this.anaMark + Math.round(T0), T0);
          if (Math.abs(this.anaMark - target) > T0 * 1.5) this.anaMark = target;
        }
        S = T0 / r; H = T0;
        this.lastVoiced = true;
      } else {
        this.anaMark = target; S = this.uvT; H = this.uvT; this.lastVoiced = false;
      }
      const Ho = Math.max(2, Math.floor(H / ff));
      this.addGrain(this.anaMark, this.synthPos, H, ff, Math.min(1.5, S / Ho));
      this.synthPos += S;
    }

    const g = p.gain;
    for (let i = 0; i < n; i++) {
      const idx = (this.readPos + i) & this.M;
      out[i] = this.outBuf[idx] * g; this.outBuf[idx] = 0;
    }
    this.readPos += n;
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Blown-out mic ("ear rape")                                          */
/* ------------------------------------------------------------------ */
/* Bass-boosted, massively over-driven hard clipping with optional bit/rate crush.
 * A voice-keyed gate keeps it silent between words so the noise floor isn't blown up too. */
class LoudProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { enabled: false, drive: 36, bass: 12, crunch: 0 };
    this.hp = new Biquad(); this.shelf = new Biquad(); this.harsh = new Biquad(); this.post = new Biquad();
    this.env = 0; this.floor = 0; this.blockMin = 1; this.minRing = new Float32Array(Math.ceil(sampleRate / 128)); this.minPos = 0;
    this.open = false; this.hold = 0; this.g = 0; this.held = 0; this.cnt = 0;
    this.configure({});
    this.port.onmessage = (e) => this.configure(e.data || {});
  }
  configure(d) {
    const p = Object.assign(this.p, d);
    this.hp.set('hp', 45, 0.707);
    this.shelf.set('lowshelf', 110, 0.707, p.bass);
    this.harsh.set('peak', 2600, 0.9, 8);
    this.post.set('hp', 25, 0.707);
    this.driveLin = dbToLin(p.drive);
    this.bitQ = p.crunch > 0 ? Math.pow(2, Math.max(3, Math.round(15 - p.crunch * 0.11)) - 1) : 0;
    this.rateN = 1 + Math.floor((p.crunch || 0) / 34);
    this.cA = timeCoef(0.6, sampleRate); this.cR = timeCoef(60, sampleRate);
    this.gA = timeCoef(1, sampleRate); this.gR = timeCoef(50, sampleRate);
    this.holdN = Math.round(0.18 * sampleRate);
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    const p = this.p;
    if (!input) { out.fill(0); return true; }
    if (!p.enabled) { out.set(input); for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out); return true; }
    this.minRing[this.minPos] = this.blockMin; this.minPos = (this.minPos + 1) % this.minRing.length; this.blockMin = 1;
    let fl = 1; for (let k = 0; k < this.minRing.length; k++) if (this.minRing[k] < fl) fl = this.minRing[k];
    const thr = Math.min(0.1, Math.max(dbToLin(-46), fl * 3.5));
    for (let i = 0; i < out.length; i++) {
      const x = input[i], ax = x < 0 ? -x : x;
      this.env = ax > this.env ? this.cA * this.env + (1 - this.cA) * ax : this.cR * this.env + (1 - this.cR) * ax;
      if (this.env < this.blockMin) this.blockMin = this.env;
      if (this.env > thr) { this.open = true; this.hold = this.holdN; } else if (this.hold > 0) this.hold--; else this.open = false;
      this.g = this.open ? this.gA * this.g + (1 - this.gA) : this.gR * this.g;
      let v = this.harsh.run(this.shelf.run(this.hp.run(x))) * this.driveLin;
      v = v > 0.92 ? 0.92 : v < -1 ? -1 : v; // asymmetric hard clip
      if (this.bitQ) v = Math.round(v * this.bitQ) / this.bitQ;
      if (this.rateN > 1) { if (this.cnt++ % this.rateN === 0) this.held = v; v = this.held; }
      out[i] = this.post.run(v) * this.g;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('micpro-denoise', DenoiseProcessor);
registerProcessor('micpro-gate', GateProcessor);
registerProcessor('micpro-deesser', DeesserProcessor);
registerProcessor('micpro-recorder', RecorderProcessor);
registerProcessor('micpro-voice', VoiceFxProcessor);
registerProcessor('micpro-shift', PitchShiftProcessor);
registerProcessor('micpro-loud', LoudProcessor);
