/*
 * MicPRO audio engine
 *
 * mic ─► channel select ─► input gain ─┬─► HPF ×2 ─► denoise ─► gate ─► EQ (low/mud/presence/air/LPF)
 *                                      │      ─► de-esser ─► warmth (parallel) ─► compressor ─► makeup
 *                                      │      ─► output trim ─► limiter ─► processed ─┐
 *                                      └──────────────────────────────── bypass ─────┴─► out bus
 * out bus ─► AudioContext destination (stream output, e.g. VB-CABLE)
 *         ─► monitor (headphones, optional)
 *         ─► analysers / recorder
 */

import { normalize, clone } from './presets.js';

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));

// Chromium's DynamicsCompressorNode adds automatic makeup gain of 0.6 × the gain
// reduction it would apply to a 0 dBFS signal. We cancel it so the UI makeup knob is honest.
function autoMakeupDb(threshold, ratio) {
  const fullRange = threshold + (0 - threshold) / ratio; // output level for 0 dBFS input (dB)
  return -0.6 * fullRange;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.settings = normalize({});
    this.running = false;
    this.bypass = false;
    this.muted = false;
    this.monitorOn = false;
    this.monitorVolume = 0.8;
    this.inputId = 'default';
    this.outputId = '';
    this.monitorId = '';
    this.inputChannel = 'mix';
    this.gateState = { open: true, gr: 0 };
    this.deessGr = 0;
    this.listeners = new Set();
    this._recording = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  static async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: all.filter((d) => d.kind === 'audioinput'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
    };
  }

  async start(opts = {}) {
    Object.assign(this, {
      inputId: opts.inputId ?? this.inputId,
      outputId: opts.outputId ?? this.outputId,
      monitorId: opts.monitorId ?? this.monitorId,
      inputChannel: opts.inputChannel ?? this.inputChannel,
    });
    if (opts.settings) this.settings = normalize(opts.settings);
    if (this.running) await this.stop();

    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await this.ctx.audioWorklet.addModule(new URL('./dsp/processors.js', import.meta.url));
    this._build();
    await this._acquire();
    await this.setOutputDevice(this.outputId);
    await this._setupMonitor();
    this.running = true;
    this.apply(this.settings);
    this.emit({ type: 'state' });
  }

  async stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.monitorEl) { this.monitorEl.pause(); this.monitorEl.srcObject = null; }
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.emit({ type: 'state' });
  }

  async _acquire() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.source) this.source.disconnect();
    const audio = {
      deviceId: this.inputId && this.inputId !== 'default' ? { exact: this.inputId } : undefined,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: !!this.settings.denoise.browserNS && this.settings.denoise.on,
      latency: { ideal: 0.01 },
    };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this._nsActive = audio.noiseSuppression;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.splitter);
    const track = this.stream.getAudioTracks()[0];
    this.inputLabel = track ? track.label : '';
    this.inputChannels = track?.getSettings?.().channelCount || 2;
    this._applyChannel();
    track?.addEventListener('ended', () => this.emit({ type: 'error', message: 'The microphone was disconnected.' }));
  }

  _build() {
    const c = this.ctx;
    const g = (v = 1) => { const n = c.createGain(); n.gain.value = v; return n; };
    const bq = (type, f = 1000, q = 0.707) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const wk = (name) => new AudioWorkletNode(c, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });

    this.splitter = c.createChannelSplitter(2);
    this.chL = g(0.5); this.chR = g(0.5);
    this.mono = g(1);
    this.mono.channelCount = 1; this.mono.channelCountMode = 'explicit';
    this.splitter.connect(this.chL, 0); this.splitter.connect(this.chR, 1);
    this.chL.connect(this.mono); this.chR.connect(this.mono);
    this.inputGain = g();
    this.mono.connect(this.inputGain);

    // 4th-order Butterworth high-pass from two biquads
    this.hpf1 = bq('highpass', 80, 0.5412);
    this.hpf2 = bq('highpass', 80, 1.3066);
    this.denoise = wk('micpro-denoise');
    this.gate = wk('micpro-gate');
    this.eqLow = bq('lowshelf', 140); this.eqMud = bq('peaking', 320, 1.2);
    this.eqPres = bq('peaking', 4500, 1); this.eqAir = bq('highshelf', 10000);
    this.lpf = bq('lowpass', 20000, 0.707);
    this.deesser = wk('micpro-deesser');

    this.satIn = g(); this.satDry = g(1); this.satWet = g(0);
    this.shaper = c.createWaveShaper(); this.shaper.oversample = '4x';
    this.satOut = g();

    this.comp = c.createDynamicsCompressor();
    this.makeup = g();
    this.trim = g();
    this.limiter = c.createDynamicsCompressor();
    this.limiterComp = g();
    this.processed = g(1);
    this.bypassGain = g(0);
    this.outBus = g(1);
    this.muteGain = g(1);

    const chain = [this.inputGain, this.hpf1, this.hpf2, this.denoise, this.gate, this.eqLow, this.eqMud, this.eqPres, this.eqAir, this.lpf, this.deesser, this.satIn];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    this.satIn.connect(this.satDry).connect(this.satOut);
    this.satIn.connect(this.shaper).connect(this.satWet).connect(this.satOut);
    this.satOut.connect(this.comp).connect(this.makeup).connect(this.trim).connect(this.limiter).connect(this.limiterComp).connect(this.processed).connect(this.outBus);
    this.inputGain.connect(this.bypassGain).connect(this.outBus);
    this.outBus.connect(this.muteGain).connect(c.destination);

    // analysis
    this.anIn = c.createAnalyser(); this.anIn.fftSize = 4096; this.anIn.smoothingTimeConstant = 0.78;
    this.anOut = c.createAnalyser(); this.anOut.fftSize = 4096; this.anOut.smoothingTimeConstant = 0.78;
    this.inputGain.connect(this.anIn);
    this.muteGain.connect(this.anOut);
    this.tIn = new Float32Array(this.anIn.fftSize); this.tOut = new Float32Array(this.anOut.fftSize);

    // monitor + recorders
    this.monitorGain = g(0);
    this.monitorDest = c.createMediaStreamDestination();
    this.muteGain.connect(this.monitorGain).connect(this.monitorDest);
    this.silent = g(0); this.silent.connect(c.destination);
    this.recRaw = wk('micpro-recorder'); this.recProc = wk('micpro-recorder');
    this.inputGain.connect(this.recRaw).connect(this.silent);
    this.muteGain.connect(this.recProc).connect(this.silent);

    this.gate.port.onmessage = (e) => { this.gateState = e.data; };
    this.deesser.port.onmessage = (e) => { this.deessGr = e.data.gr; };
    this.denoise.port.onmessage = (e) => { if (e.data.type === 'learned') this.emit({ type: 'noise-learned' }); };

    this._applyChannel();
    this._applyRouting();
  }

  _applyChannel() {
    if (!this.chL) return;
    const t = this.ctx.currentTime;
    const [l, r] = this.inputChannels === 1 ? [1, 0] : this.inputChannel === 'left' ? [1, 0] : this.inputChannel === 'right' ? [0, 1] : [0.5, 0.5];
    this.chL.gain.setTargetAtTime(l, t, 0.01);
    this.chR.gain.setTargetAtTime(r, t, 0.01);
  }

  setInputChannel(ch) { this.inputChannel = ch; this._applyChannel(); }

  _applyRouting() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.processed.gain.setTargetAtTime(this.bypass ? 0 : 1, t, 0.015);
    this.bypassGain.gain.setTargetAtTime(this.bypass ? 1 : 0, t, 0.015);
    this.muteGain.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.01);
    this.monitorGain.gain.setTargetAtTime(this.monitorOn ? this.monitorVolume : 0, t, 0.02);
  }

  setBypass(on) { this.bypass = !!on; this._applyRouting(); this.emit({ type: 'state' }); }
  setMute(on) { this.muted = !!on; this._applyRouting(); this.emit({ type: 'state' }); }
  async setMonitor(on, volume) {
    this.monitorOn = !!on;
    if (typeof volume === 'number') this.monitorVolume = volume;
    this._applyRouting();
    if (this.monitorOn && this.monitorEl && this.monitorEl.paused) await this.monitorEl.play().catch(() => {});
    this.emit({ type: 'state' });
  }

  async setOutputDevice(id) {
    this.outputId = id || '';
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    try {
      await this.ctx.setSinkId(this.outputId ? this.outputId : { type: 'none' });
    } catch (err) {
      this.emit({ type: 'error', message: `Couldn't switch the stream output: ${err.message}` });
    }
  }

  async setMonitorDevice(id) {
    this.monitorId = id || '';
    if (this.monitorEl && this.monitorEl.setSinkId) {
      await this.monitorEl.setSinkId(this.monitorId || 'default').catch(() => {});
    }
  }

  async _setupMonitor() {
    if (!this.monitorEl) { this.monitorEl = new Audio(); this.monitorEl.autoplay = true; }
    this.monitorEl.srcObject = this.monitorDest.stream;
    await this.setMonitorDevice(this.monitorId);
    await this.monitorEl.play().catch(() => {});
  }

  async setInputDevice(id) {
    this.inputId = id;
    if (this.running) { await this._acquire(); this.emit({ type: 'state' }); }
  }

  /** Push a full settings snapshot into the graph. Cheap enough to call on every knob move. */
  apply(settings) {
    this.settings = normalize(settings);
    const s = this.settings;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.02;
    const set = (param, v) => param.setTargetAtTime(v, t, k);

    set(this.inputGain.gain, dbToLin(s.inputGain));
    const hp = s.hpf.on ? s.hpf.freq : 10;
    set(this.hpf1.frequency, hp); set(this.hpf2.frequency, hp);

    this.denoise.port.postMessage({ enabled: s.denoise.on, strength: s.denoise.strength });
    const wantNS = !!s.denoise.browserNS && s.denoise.on;
    if (this.running && wantNS !== this._nsActive) this._acquire().catch((e) => this.emit({ type: 'error', message: e.message }));

    this.gate.port.postMessage({ enabled: s.gate.on, threshold: s.gate.threshold, range: s.gate.range, attack: s.gate.attack, hold: s.gate.hold, release: s.gate.release });

    const eqOn = s.eq.on;
    set(this.eqLow.frequency, s.eq.low.freq); set(this.eqLow.gain, eqOn ? s.eq.low.gain : 0);
    set(this.eqMud.frequency, s.eq.mud.freq); set(this.eqMud.gain, eqOn ? s.eq.mud.gain : 0); set(this.eqMud.Q, s.eq.mud.q);
    set(this.eqPres.frequency, s.eq.presence.freq); set(this.eqPres.gain, eqOn ? s.eq.presence.gain : 0); set(this.eqPres.Q, s.eq.presence.q);
    set(this.eqAir.frequency, s.eq.air.freq); set(this.eqAir.gain, eqOn ? s.eq.air.gain : 0);
    set(this.lpf.frequency, eqOn ? Math.min(s.eq.lpf.freq, 22000) : 22000);

    this.deesser.port.postMessage({ enabled: s.deesser.on, frequency: s.deesser.frequency, threshold: s.deesser.threshold, maxReduction: s.deesser.maxReduction });

    // warmth: parallel tanh saturation, unity small-signal gain
    const drive = 1 + (s.warmth.drive / 100) * 11;
    if (this._lastDrive !== drive) {
      const n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(drive * x) / drive; }
      this.shaper.curve = curve; this._lastDrive = drive;
    }
    const mix = s.warmth.on ? s.warmth.mix / 100 : 0;
    set(this.satWet.gain, mix); set(this.satDry.gain, 1 - mix);

    const comp = s.comp;
    const thr = comp.on ? comp.threshold : 0, ratio = comp.on ? comp.ratio : 1;
    set(this.comp.threshold, thr); set(this.comp.ratio, ratio); set(this.comp.knee, comp.on ? comp.knee : 0);
    set(this.comp.attack, comp.attack / 1000); set(this.comp.release, comp.release / 1000);
    set(this.makeup.gain, dbToLin((comp.on ? comp.makeup : 0) - autoMakeupDb(thr, ratio)));

    set(this.trim.gain, dbToLin(s.output));
    const lim = s.limiter;
    const lthr = lim.on ? lim.ceiling : 0, lratio = lim.on ? 20 : 1;
    set(this.limiter.threshold, lthr); set(this.limiter.ratio, lratio); set(this.limiter.knee, 0);
    set(this.limiter.attack, 0.001); set(this.limiter.release, 0.08);
    set(this.limiterComp.gain, dbToLin(-autoMakeupDb(lthr, lratio)));
  }

  learnNoise(seconds = 2) { this.denoise?.port.postMessage({ learn: seconds }); }
  clearNoiseProfile() { this.denoise?.port.postMessage({ clearProfile: true }); }

  meters() {
    if (!this.ctx || !this.running || !this.anIn) return null;
    const lv = (an, buf) => {
      an.getFloatTimeDomainData(buf);
      let pk = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sum += buf[i] * buf[i]; }
      return { peak: linToDb(pk), rms: linToDb(Math.sqrt(sum / buf.length)) };
    };
    return {
      input: lv(this.anIn, this.tIn),
      output: lv(this.anOut, this.tOut),
      comp: this.comp.reduction,
      limiter: this.limiter.reduction,
      gate: this.gateState,
      deess: this.deessGr,
    };
  }

  spectrum(inArr, outArr) {
    if (!this.ctx || !this.running || !this.anIn) return false;
    this.anIn.getFloatFrequencyData(inArr);
    this.anOut.getFloatFrequencyData(outArr);
    return true;
  }

  /** Combined EQ + filter magnitude response in dB at the given frequencies. */
  eqResponse(freqs, settings = this.settings) {
    const s = normalize(settings);
    const ctx = this.ctx || (this._offline ??= new OfflineAudioContext(1, 128, 48000));
    const mk = (type, f, q, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = gain; return b; };
    const on = s.eq.on;
    const hp = s.hpf.on ? s.hpf.freq : 10;
    const filters = [
      mk('highpass', hp, 0.5412), mk('highpass', hp, 1.3066),
      mk('lowshelf', s.eq.low.freq, 0.707, on ? s.eq.low.gain : 0),
      mk('peaking', s.eq.mud.freq, s.eq.mud.q, on ? s.eq.mud.gain : 0),
      mk('peaking', s.eq.presence.freq, s.eq.presence.q, on ? s.eq.presence.gain : 0),
      mk('highshelf', s.eq.air.freq, 0.707, on ? s.eq.air.gain : 0),
      mk('lowpass', on ? s.eq.lpf.freq : 22000, 0.707),
    ];
    const f32 = Float32Array.from(freqs), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    const out = new Float32Array(freqs.length).fill(0);
    for (const b of filters) {
      b.getFrequencyResponse(f32, mag, ph);
      for (let i = 0; i < out.length; i++) out[i] += linToDb(mag[i]);
    }
    return out;
  }

  /** Measure speech for `seconds` and return the input gain (dB) that puts peaks near -10 dBFS. */
  async autoLevel(seconds = 5, onProgress) {
    if (!this.running) throw new Error('Start the engine first.');
    const start = performance.now();
    const peaks = [];
    const buf = new Float32Array(this.anIn.fftSize);
    const current = this.settings.inputGain;
    while (performance.now() - start < seconds * 1000) {
      this.anIn.getFloatTimeDomainData(buf);
      let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
      peaks.push(linToDb(pk) - current); // raw mic level, independent of current gain
      onProgress?.((performance.now() - start) / (seconds * 1000));
      await new Promise((r) => setTimeout(r, 40));
    }
    const speech = peaks.filter((p) => p > -70).sort((a, b) => a - b);
    if (speech.length < 10) throw new Error('No voice detected. Check the input device and speak during the measurement.');
    const p95 = speech[Math.floor(speech.length * 0.95)];
    return Math.max(-12, Math.min(36, Math.round(-10 - p95)));
  }

  // --- recording -------------------------------------------------------------
  startRecording() {
    if (!this.running || this._recording) return;
    this._recording = { raw: [], proc: [], started: performance.now() };
    const rec = this._recording;
    this.recRaw.port.onmessage = (e) => { if (e.data.type === 'data') rec.raw.push(e.data.samples); if (e.data.type === 'stopped') rec.rawDone?.(); };
    this.recProc.port.onmessage = (e) => { if (e.data.type === 'data') rec.proc.push(e.data.samples); if (e.data.type === 'stopped') rec.procDone?.(); };
    this.recRaw.port.postMessage('start'); this.recProc.port.postMessage('start');
  }

  get isRecording() { return !!this._recording; }
  get recordingSeconds() { return this._recording ? (performance.now() - this._recording.started) / 1000 : 0; }

  async stopRecording() {
    const rec = this._recording; if (!rec) return null;
    const done = Promise.all([new Promise((r) => (rec.rawDone = r)), new Promise((r) => (rec.procDone = r))]);
    this.recRaw.port.postMessage('stop'); this.recProc.port.postMessage('stop');
    await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
    this._recording = null;
    const join = (chunks) => { const len = chunks.reduce((a, c) => a + c.length, 0); const o = new Float32Array(len); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; };
    return { sampleRate: this.ctx.sampleRate, raw: join(rec.raw), processed: join(rec.proc) };
  }

  snapshot() { return clone(this.settings); }
}

/** 24-bit mono PCM WAV */
export function encodeWav(samples, sampleRate) {
  const bytes = 3, dataLen = samples.length * bytes;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * bytes, true); v.setUint16(32, bytes, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 3) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
    v.setUint8(o, n & 0xff); v.setUint8(o + 1, (n >> 8) & 0xff); v.setUint8(o + 2, (n >> 16) & 0xff);
  }
  return buf;
}
