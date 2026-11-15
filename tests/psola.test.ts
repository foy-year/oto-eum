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

describe('sample finder', () => {
  it('finds pitched syllables with their steady vowel and root', async () => {
    const { findSyllables } = await import('../src/core/analysis/sampleFinder');
    const { mixInto } = await import('../src/core/audio/pcm');
    // three syllables: [noise "consonant" + vowel]; the 2nd glides then holds
    let p = createPcm(SR, 1, SR * 2.2);
    const syl = (at: number, f: (t: number) => number, len: number) => {
      const cons = createPcm(SR, 1, 0.04 * SR);
      cons.channels[0].forEach((_, i, a) => (a[i] = (Math.random() * 2 - 1) * 0.15));
      p = mixInto(p, cons, at);
      p = mixInto(p, voice(f, len), at + 0.04);
    };
    syl(0.1, () => 196, 0.3); // G3
    syl(0.8, (t) => (t < 0.12 ? 220 * Math.pow(2, (t - 0.12) * 10 / 12) : 220), 0.35); // glide into A3
    syl(1.5, () => 147, 0.25); // D3
    const found = findSyllables(p).sort((a, b) => a.start - b.start);
    expect(found.length).toBeGreaterThanOrEqual(3);
    const near = (t: number) => found.find((c) => Math.abs(c.steadyStart - t) < 0.2)!;
    expect(near(0.15).rootMidi).toBeCloseTo(55, 0);
    expect(near(0.95).rootMidi).toBeCloseTo(57, 0);
    expect(near(0.95).steadyStart).toBeGreaterThan(0.9); // skips the glide
    expect(near(1.55).rootMidi).toBeCloseTo(50, 0);
    for (const c of found.slice(0, 3)) expect(c.start).toBeLessThanOrEqual(c.steadyStart);
    expect(near(0.15).start).toBeLessThan(0.15); // includes the consonant
  });
});

describe('built-in voice separation', () => {
  it('pulls a centred voice out of a stereo mix (SDR gain) and stays complementary', async () => {
    const { separateVoice } = await import('../src/core/analysis/separate');
    const dur = 2.5;
    const v = voice((t) => 180 * Math.pow(2, Math.sin(t * 3) / 12), dur); // vibrato-ish melody
    const n = v.channels[0].length;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      // pad chord panned left/right with different phases
      const pad = 0.12 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t + 1) + Math.sin(2 * Math.PI * 392 * t + 2));
      L[i] = pad * 0.9;
      R[i] = 0.3 * 0.12 * (Math.sin(2 * Math.PI * 261.6 * t + 0.5) + Math.sin(2 * Math.PI * 523.2 * t));
    }
    for (const hit of [0.3, 0.8, 1.3, 1.8, 2.3]) for (let i = 0; i < 0.08 * SR; i++) {
      const j = Math.round(hit * SR) + i;
      const e = Math.exp(-i / (0.02 * SR)) * 0.5;
      L[j] += rnd() * e;
      R[j] += rnd() * e;
    }
    const voc = v.channels[0];
    const mix = { sampleRate: SR, channels: [L.map((x, i) => x + voc[i]), R.map((x, i) => x + voc[i])] };
    const { vocals, accompaniment } = separateVoice(mix);
    const sdr = (est: Float32Array) => {
      let s = 0, e = 0;
      for (let i = 0; i < n; i++) {
        s += voc[i] * voc[i];
        e += (voc[i] - est[i]) ** 2;
      }
      return 10 * Math.log10(s / e);
    };
    const base = sdr(mix.channels[0]);
    const got = sdr(vocals.channels[0]);
    console.log(`SDR mixture-as-vocals ${base.toFixed(1)} dB → separated ${got.toFixed(1)} dB`);
    expect(got - base).toBeGreaterThan(4);
    // complementary: vocals + accompaniment = mixture
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(vocals.channels[1][i] + accompaniment.channels[1][i] - mix.channels[1][i]));
    expect(maxErr).toBeLessThan(1e-5);
  });
});
