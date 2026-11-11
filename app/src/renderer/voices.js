/*
 * MicPRO voice changer voices.
 *
 * `dsp` is the voice's fixed character (bands, codec, noise colour).
 * `defaults` are the user-facing macro controls, 0-100 with 50 = the voice as designed.
 */

export const VOICES = [
  {
    id: 'walkie',
    name: 'Walkie-Talkie',
    tag: 'Handheld FM radio',
    blurb: 'Squad handheld. Keys up when you talk, hard-compressed and overdriven, and closes with the classic squelch "kssh" when you stop.',
    dsp: {
      lowCut: 380, highCut: 3100, peakFreq: 1900, peakGain: 5,
      agcTarget: -16, agcMax: 24, drive: 3.2, asym: 0.18,
      crushRate: 0, bits: 0,
      hiss: 0.05, duck: 0.75, crackle: 0.25, breakup: 0.1, fading: 0, hetFreq: 0, hetLevel: 0,
      tailLevel: 0.26, click: 0.55, beepF1: 1450, beepF2: 1000,
    },
    defaults: { static: 50, grit: 50, interference: 50, tail: 220, squelch: true, beep: false, level: 0 },
  },
  {
    id: 'tactical',
    name: 'Tactical Comms',
    tag: 'Encrypted digital headset',
    blurb: 'Cleaner military intercom. Tight digital band, a faint codec edge, a short key-up chirp and a quick squelch click on release.',
    dsp: {
      lowCut: 270, highCut: 4200, peakFreq: 2500, peakGain: 3,
      agcTarget: -16, agcMax: 18, drive: 1.9, asym: 0.06,
      crushRate: 11025, bits: 9,
      hiss: 0.022, duck: 0.85, crackle: 0.06, breakup: 0.03, fading: 0, hetFreq: 0, hetLevel: 0,
      tailLevel: 0.11, click: 0.75, beepF1: 2100, beepF2: 2600,
    },
    defaults: { static: 50, grit: 50, interference: 50, tail: 90, squelch: true, beep: true, level: 0 },
  },
  {
    id: 'field',
    name: 'Field Radio',
    tag: 'Long-range AM',
    blurb: 'Crackling long-distance set. Narrow and boxy, buried in static, with fading, a drifting heterodyne whistle and the signal breaking up.',
    dsp: {
      lowCut: 330, highCut: 2500, peakFreq: 1350, peakGain: 6,
      agcTarget: -14, agcMax: 26, drive: 4.4, asym: 0.26,
      crushRate: 0, bits: 0,
      hiss: 0.1, duck: 0.2, crackle: 0.9, breakup: 0.3, fading: 0.35, hetFreq: 1150, hetLevel: 0.025,
      tailLevel: 0.24, click: 0.4, beepF1: 1000, beepF2: 800,
    },
    defaults: { static: 50, grit: 50, interference: 50, tail: 70, squelch: true, beep: false, level: 0 },
  },
];

export const VOICE_OFF = { id: 'off' };

export function voiceDefaults(id) {
  const v = VOICES.find((x) => x.id === id);
  return v ? { id, ...v.defaults } : { ...VOICE_OFF };
}

/** Combine a voice's fixed character with the user's macro settings into worklet parameters. */
export function voiceDsp(state) {
  const v = VOICES.find((x) => x.id === state?.id);
  if (!v) return { enabled: false };
  const s = { ...v.defaults, ...state };
  const curve = (m, k) => Math.pow(Math.max(0, m) / 50, k);
  const d = v.dsp;
  return {
    enabled: true,
    ...d,
    hiss: d.hiss * curve(s.static, 1.6),
    hetLevel: d.hetLevel * curve(s.static, 1.6),
    drive: d.drive * Math.pow(2, (s.grit - 50) / 20),
    asym: d.asym * curve(s.grit, 1),
    crackle: d.crackle * curve(s.interference, 1.5),
    breakup: d.breakup * curve(s.interference, 2),
    fading: Math.min(0.9, d.fading * curve(s.interference, 1)),
    tailMs: s.tail,
    squelch: !!s.squelch,
    beep: !!s.beep,
    out: s.level,
  };
}
