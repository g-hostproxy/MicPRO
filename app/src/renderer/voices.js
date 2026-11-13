/*
 * MicPRO voice changer voices.
 *
 * Each voice declares:
 *  - controls / toggles: the knobs and switches shown in the Voice changer panel
 *  - defaults:           starting values for those controls
 *  - build(state):       turns the control values into engine parameters
 *
 * Engine parameter groups (all optional):
 *  shift  { enabled, ratio, formant }      PSOLA pitch + formant shifter
 *  sub    { enabled, ratio, formant, mix } parallel shifted layer (e.g. an octave below)
 *  eq     { hp, lowFreq, lowGain, highFreq, highGain }
 *  loud   { enabled, drive, bass, crunch } blown-out mic
 *  radio  { enabled, ... }                 two-way radio model
 *  reverb { mix, dry, size, predelay, damp }
 *  level  output trim in dB
 *  monitorSafety  multiplier on the headphone monitor (protects your ears)
 */

const st = (semitones) => Math.pow(2, semitones / 12);
const curve = (m, k) => Math.pow(Math.max(0, m) / 50, k);

/* ---------------- radio ---------------- */

const RADIO_CONTROLS = [
  { path: 'static', label: 'Static', min: 0, max: 100, step: 1, unit: '%' },
  { path: 'grit', label: 'Grit', min: 0, max: 100, step: 1, unit: '%' },
  { path: 'interference', label: 'Interference', min: 0, max: 100, step: 1, unit: '%' },
  { path: 'tail', label: 'Tail length', min: 30, max: 500, step: 5, unit: 'ms' },
  { path: 'level', label: 'Level', min: -12, max: 12, step: 0.5, unit: 'dB' },
];
const RADIO_TOGGLES = [
  { path: 'squelch', label: 'Squelch tail' },
  { path: 'beep', label: 'Roger beep' },
];

function radioBuild(d) {
  return (s) => ({
    radio: {
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
      out: 0,
    },
    level: s.level,
  });
}

/* ---------------- voices ---------------- */

export const VOICES = [
  {
    id: 'walkie',
    name: 'Walkie-Talkie',
    tag: 'Handheld FM radio',
    blurb: 'Squad handheld. Keys up when you talk, hard-compressed and overdriven, and closes with the classic squelch "kssh" when you stop.',
    controls: RADIO_CONTROLS, toggles: RADIO_TOGGLES,
    defaults: { static: 50, grit: 50, interference: 50, tail: 220, squelch: true, beep: false, level: 0 },
    build: radioBuild({
      lowCut: 380, highCut: 3100, peakFreq: 1900, peakGain: 5,
      agcTarget: -16, agcMax: 24, drive: 3.2, asym: 0.18, crushRate: 0, bits: 0,
      hiss: 0.05, duck: 0.75, crackle: 0.25, breakup: 0.1, fading: 0, hetFreq: 0, hetLevel: 0,
      tailLevel: 0.26, click: 0.55, beepF1: 1450, beepF2: 1000,
    }),
  },
  {
    id: 'tactical',
    name: 'Tactical Comms',
    tag: 'Encrypted digital headset',
    blurb: 'Cleaner military intercom. Tight digital band, a faint codec edge, a short key-up chirp and a quick squelch click on release.',
    controls: RADIO_CONTROLS, toggles: RADIO_TOGGLES,
    defaults: { static: 50, grit: 50, interference: 50, tail: 90, squelch: true, beep: true, level: 0 },
    build: radioBuild({
      lowCut: 270, highCut: 4200, peakFreq: 2500, peakGain: 3,
      agcTarget: -16, agcMax: 18, drive: 1.9, asym: 0.06, crushRate: 11025, bits: 9,
      hiss: 0.022, duck: 0.85, crackle: 0.06, breakup: 0.03, fading: 0, hetFreq: 0, hetLevel: 0,
      tailLevel: 0.11, click: 0.75, beepF1: 2100, beepF2: 2600,
    }),
  },
  {
    id: 'field',
    name: 'Field Radio',
    tag: 'Long-range AM',
    blurb: 'Crackling long-distance set. Narrow and boxy, buried in static, with fading, a drifting heterodyne whistle and the signal breaking up.',
    controls: RADIO_CONTROLS, toggles: RADIO_TOGGLES,
    defaults: { static: 50, grit: 50, interference: 50, tail: 70, squelch: true, beep: false, level: 0 },
    build: radioBuild({
      lowCut: 330, highCut: 2500, peakFreq: 1350, peakGain: 6,
      agcTarget: -14, agcMax: 26, drive: 4.4, asym: 0.26, crushRate: 0, bits: 0,
      hiss: 0.1, duck: 0.2, crackle: 0.9, breakup: 0.3, fading: 0.35, hetFreq: 1150, hetLevel: 0.025,
      tailLevel: 0.24, click: 0.4, beepF1: 1000, beepF2: 800,
    }),
  },
  {
    id: 'girl',
    name: 'Girl',
    tag: 'Female voice',
    blurb: 'Raises your pitch and shrinks your vocal tract separately, so it sounds like a different person instead of a sped-up recording. Lower Pitch if it sounds cartoonish.',
    controls: [
      { path: 'pitch', label: 'Pitch', min: 0, max: 12, step: 0.5, unit: 'st' },
      { path: 'formant', label: 'Formant', min: 0, max: 6, step: 0.1, unit: 'st' },
      { path: 'bright', label: 'Brightness', min: -6, max: 9, step: 0.5, unit: 'dB' },
      { path: 'level', label: 'Level', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
    toggles: [],
    defaults: { pitch: 7, formant: 3, bright: 3, level: 0 },
    build: (s) => ({
      shift: { enabled: true, ratio: st(s.pitch), formant: st(s.formant), gain: 1 },
      eq: { hp: 140, lowFreq: 260, lowGain: -2, highFreq: 5500, highGain: s.bright },
      level: s.level + 4, // matches your normal speaking level
    }),
  },
  {
    id: 'god',
    name: 'God',
    tag: 'Deep and colossal',
    blurb: 'A huge, deep voice with a sub-octave rumble underneath, echoing through an enormous hall.',
    controls: [
      { path: 'pitch', label: 'Pitch', min: -12, max: 0, step: 0.5, unit: 'st' },
      { path: 'formant', label: 'Size', min: -6, max: 0, step: 0.1, unit: 'st' },
      { path: 'sub', label: 'Rumble', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'reverb', label: 'Reverb', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'size', label: 'Hall', min: 1, max: 10, step: 0.1, unit: 's' },
      { path: 'level', label: 'Level', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
    toggles: [],
    defaults: { pitch: -5, formant: -3, sub: 40, reverb: 70, size: 6, level: 0 },
    build: (s) => ({
      shift: { enabled: true, ratio: st(s.pitch), formant: st(s.formant), gain: 1 },
      sub: { enabled: s.sub > 0, ratio: st(s.pitch - 12), formant: st(s.formant), gain: 1, mix: (s.sub / 100) * 0.9 },
      eq: { hp: 35, lowFreq: 160, lowGain: 4, highFreq: 6500, highGain: -3 },
      reverb: { mix: (s.reverb / 100) * 1.1, dry: 1 - (s.reverb / 100) * 0.35, size: s.size, predelay: 0.05, damp: 0.65 },
      level: s.level - 6, // reverb + rumble add a lot of energy; keep the switch level-matched
    }),
  },
  {
    id: 'loud',
    name: 'Blown Out',
    tag: 'Ear-rape mic',
    blurb: 'Your mic, destroyed: bass-boosted, clipped to the ceiling and crunchy. It stays silent between words. Your headphone monitor drops 12 dB while it\'s on to protect your ears.',
    controls: [
      { path: 'loudness', label: 'Loudness', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'bass', label: 'Bass', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'crunch', label: 'Crunch', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'level', label: 'Level', min: -24, max: 0, step: 0.5, unit: 'dB' },
    ],
    toggles: [],
    defaults: { loudness: 75, bass: 60, crunch: 35, level: 0 },
    build: (s) => ({
      loud: { enabled: true, drive: 14 + s.loudness * 0.34, bass: s.bass * 0.2, crunch: s.crunch },
      level: s.level,
      monitorSafety: 0.25,
    }),
  },
];

export function voiceDefaults(id) {
  const v = VOICES.find((x) => x.id === id);
  return v ? { id, ...v.defaults } : { id: 'off' };
}

/** Engine parameters for a voice state ({} = voice changer off). */
export function voiceDsp(state) {
  const v = VOICES.find((x) => x.id === state?.id);
  if (!v) return {};
  return v.build({ ...v.defaults, ...state });
}
