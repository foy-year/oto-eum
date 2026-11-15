/**
 * TD-PSOLA (time-domain pitch-synchronous overlap-add).
 *
 * Changes pitch without changing duration, and keeps the spectral envelope
 * (formants) — a voice shifted up stays a voice instead of a chipmunk.
 * Used for:
 *  - flattenPitch: "tune" a gliding syllable to one steady note
 *  - shiftPitch: formant-preserving transposition ('natural' pitch mode)
 */
import { type Pcm, toMono, lengthOf } from '../audio/pcm';
import { trackPitch } from '../analysis/pitch';

export interface F0Track {
  /** Seconds between values. */
  hop: number;
  /** Time of the first value. */
  t0: number;
  /** Hz; 0 = unvoiced. */
  f0: Float32Array;
}

/** Fine f0 track with short gaps bridged and single-frame octave errors removed. */
export function analyzeF0(pcm: Pcm, opts: { minHz?: number; maxHz?: number } = {}): F0Track {
  const frames = trackPitch(pcm, { minHz: opts.minHz ?? 60, maxHz: opts.maxHz ?? 1200, threshold: 0.2, hop: 80, analysisRate: 16000, silence: 0.005 });
  const f0 = Float32Array.from(frames, (f) => (f.confidence > 0.6 ? f.f0 : 0));
  // median-3 in log space to kill single-frame jumps
  const g = f0.slice();
  for (let i = 1; i < f0.length - 1; i++) {
    const w = [f0[i - 1], f0[i], f0[i + 1]].filter((v) => v > 0).sort((a, b) => a - b);
    if (f0[i] > 0 && w.length === 3) g[i] = w[1];
  }
  // bridge gaps up to 3 frames
  for (let i = 1; i < g.length; i++) {
    if (g[i] > 0 || g[i - 1] === 0) continue;
    let j = i;
    while (j < g.length && g[j] === 0) j++;
    if (j < g.length && j - i <= 3) for (let k = i; k < j; k++) g[k] = g[i - 1] + ((g[j] - g[i - 1]) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.005;
  return { hop, t0: frames[0]?.time ?? 0, f0: g };
}

function f0At(tr: F0Track, t: number): number {
  const i = Math.round((t - tr.t0) / tr.hop);
  if (i < 0 || i >= tr.f0.length) return 0;
  return tr.f0[i];
}

/**
 * Pitch marks (one per glottal period in voiced parts, every 5 ms elsewhere),
 * placed on the strongest positive peak of each period.
 */
export function pitchMarks(x: Float32Array, sr: number, tr: F0Track): Array<{ pos: number; period: number; voiced: boolean }> {
  const marks: Array<{ pos: number; period: number; voiced: boolean }> = [];
  const unv = Math.round(0.005 * sr);
  let pos = 0;
  while (pos < x.length) {
    const f = f0At(tr, pos / sr);
    if (f > 0) {
      const P = sr / f;
      // snap to the largest sample within ±P/2 (first mark) or ±P/5 around the expected position
      const span = marks.length && marks[marks.length - 1].voiced ? P * 0.2 : P * 0.5;
      let best = Math.round(pos);
      for (let k = Math.max(0, Math.round(pos - span)); k <= Math.min(x.length - 1, Math.round(pos + span)); k++) if (x[k] > x[best]) best = k;
      if (marks.length && best <= marks[marks.length - 1].pos) best = Math.round(marks[marks.length - 1].pos + P);
      marks.push({ pos: best, period: P, voiced: true });
      pos = Math.round(best + P);
    } else {
      marks.push({ pos, period: unv, voiced: false });
      pos += unv;
    }
  }
  return marks;
}

/**
 * Re-synthesise with pitch factor ratioAt(t) (1 = unchanged, 2 = octave up)
 * at the same duration.
 */
export function psola(pcm: Pcm, ratioAt: (t: number, f0: number) => number, tr: F0Track = analyzeF0(pcm)): Pcm {
  const sr = pcm.sampleRate;
  const mono = toMono(pcm);
  const marks = pitchMarks(mono, sr, tr);
  const n = lengthOf(pcm);
  const out = pcm.channels.map(() => new Float32Array(n));
  const norm = new Float32Array(n);
  if (!marks.length) return pcm;
  let ts = marks[0].pos;
  let mi = 0;
  while (ts < n) {
    // analysis mark nearest to the synthesis time (1:1 time map → same duration)
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1].pos - ts) <= Math.abs(marks[mi].pos - ts)) mi++;
    const m = marks[mi];
    const f = m.voiced ? sr / m.period : 0;
    const ratio = m.voiced ? Math.max(0.25, Math.min(4, ratioAt(ts / sr, f))) : 1;
    const half = Math.round(m.voiced ? m.period : m.period * 2); // grain = 2 periods
    for (let k = -half; k <= half; k++) {
      const src = Math.round(m.pos) + k;
      const dst = Math.round(ts) + k;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1));
      for (let c = 0; c < out.length; c++) out[c][dst] += pcm.channels[c][src] * w;
      norm[dst] += w;
    }
    ts += m.voiced ? m.period / ratio : m.period;
  }
  for (let i = 0; i < n; i++) {
    const w = norm[i];
    if (w > 1e-3) for (const ch of out) ch[i] /= Math.max(w, 0.5);
  }
  // keep loudness: grain density changes with the ratio
  const e = (chs: Float32Array[]) => chs.reduce((s, ch) => s + ch.reduce((a, v) => a + v * v, 0), 0);
  const ein = e(pcm.channels);
  const eout = e(out);
  if (eout > 0 && ein > 0) {
    const g = Math.min(4, Math.max(0.25, Math.sqrt(ein / eout)));
    for (const ch of out) for (let i = 0; i < n; i++) ch[i] *= g;
  }
  return { sampleRate: sr, channels: out };
}

/** Formant-preserving transposition by a constant number of semitones. */
export function shiftPitch(pcm: Pcm, semitones: number, tr?: F0Track): Pcm {
  if (Math.abs(semitones) < 1e-3) return pcm;
  const r = Math.pow(2, semitones / 12);
  return psola(pcm, () => r, tr);
}

/**
 * Tune a sample to a steady pitch. `strength` 1 = completely flat, 0.5 =
 * halfway (keeps some natural movement). Target defaults to the median f0.
 */
export function flattenPitch(pcm: Pcm, opts: { strength?: number; targetHz?: number } = {}): { pcm: Pcm; targetHz: number } {
  const tr = analyzeF0(pcm);
  const voiced = Array.from(tr.f0).filter((v) => v > 0).sort((a, b) => a - b);
  if (!voiced.length) return { pcm, targetHz: 0 };
  const target = opts.targetHz ?? voiced[voiced.length >> 1];
  const s = opts.strength ?? 1;
  return { pcm: psola(pcm, (_t, f0) => (f0 > 0 ? Math.pow(target / f0, s) : 1), tr), targetHz: target };
}
