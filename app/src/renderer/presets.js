/*
 * MicPRO factory presets.
 * Every preset is a full snapshot of the processing chain so switching is predictable.
 * Gains are in dB, times in ms, frequencies in Hz.
 */

export const DEFAULT_SETTINGS = {
  inputGain: 0,
  hpf: { on: true, freq: 80 },
  denoise: { on: true, strength: 0.5, browserNS: false },
  gate: { on: true, threshold: -50, range: -30, attack: 2, hold: 150, release: 180 },
  eq: {
    on: true,
    low: { freq: 140, gain: 0 },
    mud: { freq: 320, gain: 0, q: 1.2 },
    presence: { freq: 4500, gain: 0, q: 1.0 },
    air: { freq: 10000, gain: 0 },
    lpf: { freq: 20000 },
  },
  deesser: { on: true, frequency: 6500, threshold: -32, maxReduction: 8 },
  warmth: { on: false, drive: 20, mix: 30 },
  comp: { on: true, threshold: -20, ratio: 3, attack: 5, release: 120, knee: 6, makeup: 4 },
  limiter: { on: true, ceiling: -1 },
  output: 0,
};

export const FACTORY_PRESETS = [
  {
    id: 'sm7b',
    name: 'Shure SM7B',
    tag: 'Broadcast dynamic',
    blurb:
      'Opens up the SM7B\'s dark top end, tames proximity boom and adds the extra gain it always needs. Use with the bass roll-off and presence switches on the mic set flat.',
    settings: {
      inputGain: 6,
      hpf: { on: true, freq: 75 },
      // dynamic mic already rejects the room — keep denoise light so it never touches the voice
      denoise: { on: true, strength: 0.3, browserNS: false },
      gate: { on: true, threshold: -52, range: -24, attack: 2, hold: 180, release: 220 },
      eq: {
        on: true,
        low: { freq: 120, gain: 1.5 },          // chest / warmth
        mud: { freq: 300, gain: -3, q: 1.1 },    // proximity boxiness
        presence: { freq: 4200, gain: 3.5, q: 0.9 }, // intelligibility over gunfire
        air: { freq: 11000, gain: 4 },           // the SM7B rolls off early; bring back sparkle
        lpf: { freq: 18000 },
      },
      deesser: { on: true, frequency: 6800, threshold: -30, maxReduction: 8 },
      warmth: { on: true, drive: 18, mix: 22 },
      comp: { on: true, threshold: -22, ratio: 3.5, attack: 6, release: 130, knee: 6, makeup: 6 },
      limiter: { on: true, ceiling: -1 },
      output: 0,
    },
  },
  {
    id: 'prox',
    name: 'Logitech G Pro X',
    tag: 'Headset rescue',
    blurb:
      'Heavier cleanup for the Pro X boom mic: strong denoise, a tighter gate, body added under the voice and the nasal, tinny range scooped out. Turn Blue VO!CE off in G HUB so it isn\'t processed twice.',
    settings: {
      inputGain: 0,
      hpf: { on: true, freq: 100 },
      denoise: { on: true, strength: 0.75, browserNS: true },
      gate: { on: true, threshold: -44, range: -40, attack: 1.5, hold: 120, release: 150 },
      eq: {
        on: true,
        low: { freq: 160, gain: 4 },              // headset mics have no chest
        mud: { freq: 900, gain: -3, q: 1.4 },      // nasal / boxy honk
        presence: { freq: 3200, gain: -1.5, q: 1.6 }, // harsh electret bite
        air: { freq: 9000, gain: 1 },
        lpf: { freq: 14000 },                      // hiss above the voice
      },
      deesser: { on: true, frequency: 6000, threshold: -34, maxReduction: 10 },
      warmth: { on: true, drive: 25, mix: 30 },
      comp: { on: true, threshold: -24, ratio: 4, attack: 4, release: 110, knee: 8, makeup: 7 },
      limiter: { on: true, ceiling: -1 },
      output: 0,
    },
  },
  {
    id: 'streamer',
    name: 'Clean Streamer',
    tag: 'Any mic',
    blurb: 'A safe, polished starting point for any USB or XLR mic: tidy low end, gentle presence, even levels.',
    settings: {
      inputGain: 0,
      hpf: { on: true, freq: 85 },
      denoise: { on: true, strength: 0.5, browserNS: false },
      gate: { on: true, threshold: -48, range: -30, attack: 2, hold: 150, release: 180 },
      eq: {
        on: true,
        low: { freq: 140, gain: 1 },
        mud: { freq: 350, gain: -2, q: 1.2 },
        presence: { freq: 4000, gain: 2, q: 1.0 },
        air: { freq: 10000, gain: 2 },
        lpf: { freq: 19000 },
      },
      deesser: { on: true, frequency: 6500, threshold: -32, maxReduction: 8 },
      warmth: { on: false, drive: 15, mix: 20 },
      comp: { on: true, threshold: -20, ratio: 3, attack: 5, release: 120, knee: 6, makeup: 5 },
      limiter: { on: true, ceiling: -1 },
      output: 0,
    },
  },
  {
    id: 'voiceover',
    name: 'Movie Voiceover',
    tag: 'Narration',
    blurb: 'Deep, close, controlled narration for the intro and outro of a raid edit. Heavier compression keeps every word upfront under music.',
    settings: {
      inputGain: 0,
      hpf: { on: true, freq: 65 },
      denoise: { on: true, strength: 0.55, browserNS: false },
      gate: { on: true, threshold: -50, range: -36, attack: 2, hold: 200, release: 250 },
      eq: {
        on: true,
        low: { freq: 110, gain: 3.5 },
        mud: { freq: 280, gain: -3.5, q: 1.0 },
        presence: { freq: 3800, gain: 2.5, q: 0.9 },
        air: { freq: 12000, gain: 3 },
        lpf: { freq: 19000 },
      },
      deesser: { on: true, frequency: 6800, threshold: -34, maxReduction: 10 },
      warmth: { on: true, drive: 30, mix: 30 },
      comp: { on: true, threshold: -26, ratio: 5, attack: 8, release: 160, knee: 6, makeup: 9 },
      limiter: { on: true, ceiling: -1 },
      output: 0,
    },
  },
];

export function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** Deep-merge a (possibly partial / older) settings object onto the defaults. */
export function normalize(settings) {
  const out = clone(DEFAULT_SETTINGS);
  const merge = (dst, src) => {
    if (!src || typeof src !== 'object') return;
    for (const k of Object.keys(dst)) {
      if (!(k in src)) continue;
      if (dst[k] && typeof dst[k] === 'object') merge(dst[k], src[k]);
      else if (typeof src[k] === typeof dst[k]) dst[k] = src[k];
    }
  };
  merge(out, settings);
  return out;
}
