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

registerProcessor('micpro-denoise', DenoiseProcessor);
registerProcessor('micpro-gate', GateProcessor);
registerProcessor('micpro-deesser', DeesserProcessor);
registerProcessor('micpro-recorder', RecorderProcessor);
