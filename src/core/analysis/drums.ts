/**
 * Drum kit from any source: classify its transients into kick / snare / hat
 * candidates, and generate drum patterns on the project grid.
 */
import { type Pcm, slice, toMono, rms } from '../audio/pcm';
import type { Note } from '../types';
import { detectOnsets } from './onset';
import { stft } from './fft';
import { gridSeconds } from '../midi/midi';

export type DrumKind = 'kick' | 'snare' | 'hat';

export interface DrumHit {
  time: number;
  /** Suggested sample length (s). */
  length: number;
  low: number;
  mid: number;
  high: number;
  /** Spectral flatness 0..1 (1 = noise). */
  noise: number;
  punch: number;
  /** Energy 80 ms after the hit relative to the first 30 ms (lower = shorter). */
  decay: number;
  score: Record<DrumKind, number>;
}

function features(pcm: Pcm, t: number): Omit<DrumHit, 'score' | 'length'> {
  const sr = pcm.sampleRate;
  const x = toMono(slice(pcm, t, t + 0.15));
  const spec = stft(x, 1024, 256).slice(0, 3);
  const binHz = sr / 1024;
  let low = 0, mid = 0, high = 0, logSum = 0, lin = 0, n = 0;
  for (const fr of spec)
    fr.forEach((v, k) => {
      const f = k * binHz;
      const e = v * v;
      if (f < 150) low += e;
      else if (f < 4000) mid += e;
      else high += e;
      if (f > 100) {
        logSum += Math.log(e + 1e-12);
        lin += e;
        n++;
      }
    });
  const tot = low + mid + high + 1e-12;
  const noise = n ? Math.exp(logSum / n) / (lin / n + 1e-12) : 0;
  const early = rms(x, 0, Math.round(0.03 * sr));
  const late = rms(x, Math.round(0.08 * sr), x.length);
  return { time: t, low: low / tot, mid: mid / tot, high: high / tot, noise, punch: early, decay: late / (early + 1e-9) };
}

/** Best candidates per drum kind (each hit used for at most one kind). */
export function findDrumHits(pcm: Pcm, opts: { perKind?: number; minSpacing?: number } = {}): Record<DrumKind, DrumHit[]> {
  const { onsets } = detectOnsets(pcm, { sensitivity: 1.0, minInterval: 0.05 });
  const maxPunch = Math.max(1e-6, ...onsets.map((t) => features(pcm, t).punch));
  const hits: DrumHit[] = onsets
    .map((t) => features(pcm, Math.max(0, t - 0.005)))
    .filter((f) => f.punch > maxPunch * 0.15)
    .map((f) => {
      const p = f.punch / maxPunch;
      const short = Math.max(0, 1 - f.decay);
      return {
        ...f,
        length: 0,
        score: {
          kick: f.low * (0.4 + 0.6 * short) * p,
          // real sources have a music bed under every hit: noisiness is a bonus, not a gate
          snare: (f.mid * 0.4 + f.high * 0.6) * (1 - f.low) * (0.6 + 0.4 * Math.min(1, f.noise * 8)) * p,
          hat: f.high * f.high * (0.3 + 0.7 * short) * (0.6 + 0.4 * Math.min(1, f.noise * 8)) * Math.sqrt(p),
        },
      };
    });
  const out: Record<DrumKind, DrumHit[]> = { kick: [], snare: [], hat: [] };
  const used = new Set<number>();
  const spacing = opts.minSpacing ?? 0.15;
  const per = opts.perKind ?? 3;
  for (const kind of ['kick', 'hat', 'snare'] as DrumKind[]) {
    const len = kind === 'kick' ? 0.18 : kind === 'snare' ? 0.16 : 0.06;
    for (const h of hits.slice().sort((a, b) => b.score[kind] - a.score[kind])) {
      if (out[kind].length >= per) break;
      if (used.has(h.time) || out[kind].some((o) => Math.abs(o.time - h.time) < spacing)) continue;
      if (h.score[kind] <= 0) continue;
      used.add(h.time);
      out[kind].push({ ...h, length: len });
    }
  }
  return out;
}

/** 16-step patterns (one 4/4 bar). Numbers are velocities; 0 = rest. */
export const DRUM_PATTERNS: Record<string, { label: string; kick: number[]; snare: number[]; hat: number[] }> = {
  drive: { label: '音MAD drive (kick 1 & 3 + push)', kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.8, 0], snare: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0], hat: [0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0, 0.8, 0, 0.5, 0] },
  four: { label: 'Four on the floor', kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], snare: [0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0], hat: [0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0, 0, 0, 0.8, 0] },
  rock: { label: 'Rock backbeat', kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.8, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0] },
  break: { label: 'Breakbeat', kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0.4, 0, 0.3, 0, 0, 1, 0, 0, 0], hat: [0.7, 0.4, 0.7, 0.4, 0.7, 0.4, 0.7, 0.4, 0.7, 0.4, 0.7, 0.4, 0.7, 0.4, 0.7, 0.4] },
  half: { label: 'Half-time', kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], hat: [0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8, 0, 0.6, 0] },
  trap: { label: 'Trap (16th hats)', kick: [1, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], hat: [0.8, 0.5, 0.7, 0.5, 0.8, 0.5, 0.7, 0.5, 0.8, 0.5, 0.7, 0.5, 0.8, 0.6, 0.7, 0.9] },
};

/** Notes for a pattern between `from` and `to` (seconds), aligned to the grid. */
export function drumPattern(name: keyof typeof DRUM_PATTERNS | string, o: { bpm: number; from: number; to: number; gridOffset?: number }): Record<DrumKind, Note[]> {
  const p = DRUM_PATTERNS[name] ?? DRUM_PATTERNS.drive;
  const step = gridSeconds(o.bpm, 16);
  const off = o.gridOffset ?? 0;
  const first = off + Math.ceil((o.from - off) / step - 1e-6) * step;
  const out: Record<DrumKind, Note[]> = { kick: [], snare: [], hat: [] };
  const durs: Record<DrumKind, number> = { kick: step * 2, snare: step * 2, hat: step };
  for (let t = first, k = Math.round((first - off) / step); t < o.to - 1e-6; t += step, k++) {
    const i = ((k % 16) + 16) % 16;
    for (const kind of ['kick', 'snare', 'hat'] as DrumKind[]) {
      const v = p[kind][i];
      if (v > 0) out[kind].push({ id: `${kind}${k}`, pitch: 60, start: t, duration: durs[kind], velocity: v });
    }
  }
  return out;
}
