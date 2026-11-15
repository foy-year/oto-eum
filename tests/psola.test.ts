import { describe, expect, it } from 'vitest';
import { type Pcm, createPcm, durationOf, slice, resample, normalize } from '../src/core/audio/pcm';
import { applyEffects, createEffect } from '../src/core/render/effects';
import { flattenPitch, shiftPitch } from '../src/core/render/psola';
import { detectRootPitch, hzToMidi, trackPitch } from '../src/core/analysis/pitch';
import { stft } from '../src/core/analysis/fft';

const SR = 44100;
/** Vowel-like test signal: glottal pulses (f0 may glide) through two formant resonators. */
function voice(f0: (t: number) => number, seconds: number): Pcm {
  const p = createPcm(SR, 1, seconds * SR);
  const x = p.channels[0];
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    phase += f0(i / SR) / SR;
    if (phase >= 1) {
      phase -= 1;
      x[i] = 1;
    }
  }
  const f = applyEffects(p, [createEffect('bandpass', { freq: 700, q: 4 }), createEffect('gain', { db: 6 })]);
  const g = applyEffects(p, [createEffect('bandpass', { freq: 1200, q: 5 })]);
  for (let i = 0; i < x.length; i++) x[i] = f.channels[0][i] + 0.6 * g.channels[0][i];
  return normalize(p, 0.8);
}
/** Frequency of the strongest spectral peak between 300 and 3000 Hz (≈ first formant region). */
function formantPeak(p: Pcm): number {
  const spec = stft(p.channels[0], 4096, 2048);
  const avg = new Float32Array(spec[0].length);
  for (const fr of spec) fr.forEach((v, k) => (avg[k] += v));
  // smooth over ±150 Hz to see the envelope, not the harmonics
  const binHz = SR / 4096;
  const w = Math.round(150 / binHz);
  let best = 0;
  let bestF = 0;
  for (let k = Math.round(300 / binHz); k < Math.round(3000 / binHz); k++) {
    let s = 0;
    for (let j = -w; j <= w; j++) s += avg[k + j] ?? 0;
    if (s > best) [best, bestF] = [s, k * binHz];
  }
  return bestF;
}
const spread = (p: Pcm) => {
  const m = trackPitch(p, { minHz: 80, maxHz: 600 }).filter((f) => f.f0 > 0).map((f) => hzToMidi(f.f0)).sort((a, b) => a - b);
  return m[Math.floor(m.length * 0.9)] - m[Math.floor(m.length * 0.1)];
};

describe('PSOLA', () => {
  it('flattens a gliding syllable to one steady pitch, same length', () => {
    const glide = voice((t) => 180 * Math.pow(2, (t * 3) / 12), 0.6); // rises 1.8 semitones
    expect(spread(glide)).toBeGreaterThan(1.2);
    const { pcm, targetHz } = flattenPitch(glide);
    expect(durationOf(pcm)).toBeCloseTo(durationOf(glide), 5);
    expect(spread(slice(pcm, 0.05, 0.55))).toBeLessThan(0.25);
    expect(detectRootPitch(pcm)!.hz).toBeCloseTo(targetHz, -1);
  });

  it('shifts pitch but keeps the formant (unlike resampling)', () => {
    const v = voice(() => 150, 0.8);
    const up = shiftPitch(v, 7);
    expect(durationOf(up)).toBeCloseTo(durationOf(v), 5);
    expect(detectRootPitch(up)!.midi - detectRootPitch(v)!.midi).toBeCloseTo(7, 0);
    const chip = { sampleRate: SR, channels: resample(v, Math.round(SR / Math.pow(2, 7 / 12))).channels };
    const f0 = formantPeak(v);
    expect(Math.abs(formantPeak(up) - f0) / f0).toBeLessThan(0.15);
    expect(formantPeak(chip) / f0).toBeGreaterThan(1.3);
  });
});

describe("sampler 'natural' mode", () => {
  it('plays notes at the right pitch, at original speed, for video too', async () => {
    const { renderTrack, playbackRate } = await import('../src/core/render/sampler');
    const { createSample, createTrack } = await import('../src/core/project');
    const { buildSyncEvents, DEFAULT_SYNC } = await import('../src/core/video/timeline');
    const v = voice(() => 150, 0.6);
    const root = detectRootPitch(v)!.midi;
    const s = createSample('src', 0, 0.6, { rootPitch: Math.round(root), rootCents: Math.round((root - Math.round(root)) * 100), pitchMode: 'natural', sustain: 'full' });
    const notes = [{ id: 'a', pitch: Math.round(root) + 5, start: 0, duration: 0.6, velocity: 1 }];
    const out = renderTrack(notes, v, s, { sampleRate: SR, channels: 1 });
    expect(durationOf(out)).toBeCloseTo(0.6, 2); // speed unchanged ('full' plays the whole clip)
    expect(detectRootPitch(slice(out, 0.1, 0.5))!.midi).toBeCloseTo(Math.round(root) + 5, 0);
    expect(playbackRate(s, Math.round(root) + 5)).toBe(1);
    const ev = buildSyncEvents({ tracks: [createTrack('t', { sampleId: s.id, notes })], samples: [s], assets: [{ id: 'src', kind: 'video', duration: 1 }], settings: DEFAULT_SYNC });
    expect(ev[0].rate).toBe(1);
  });
});
