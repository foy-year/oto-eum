/**
 * Compare notes with real audio.
 *  - alignNotesToAudio: find the semitone / octave offset that makes notes
 *    (e.g. read from a piano-roll video) agree with the video's soundtrack.
 *  - chromaAgreement / pitchAccuracy: self-checks for a rendered track.
 */
import { type Pcm, toMono, resample, slice } from '../audio/pcm';
import type { Note } from '../types';
import { fft, stft } from './fft';
import { detectRootPitch } from './pitch';

export interface Chromagram {
  frames: Float32Array[];
  /** Seconds per frame. */
  hop: number;
  /** Time of frame 0's centre. */
  t0: number;
}

export function chromagram(pcm: Pcm, opts: { size?: number; hop?: number; fmin?: number; fmax?: number } = {}): Chromagram {
  const sr = 22050;
  const x = resample({ sampleRate: pcm.sampleRate, channels: [toMono(pcm)] }, sr).channels[0];
  const size = opts.size ?? 4096;
  const hop = opts.hop ?? 1024;
  const fmin = opts.fmin ?? 80;
  const fmax = opts.fmax ?? 2000;
  const spec = stft(x, size, hop);
  const binHz = sr / size;
  const pcOf = new Int8Array(size / 2 + 1).fill(-1);
  for (let k = 1; k <= size / 2; k++) {
    const f = k * binHz;
    if (f >= fmin && f <= fmax) pcOf[k] = ((((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12) as number;
  }
  const frames = spec.map((fr) => {
    const c = new Float32Array(12);
    fr.forEach((v, k) => {
      if (pcOf[k] >= 0) c[pcOf[k]] += v * v;
    });
    return c;
  });
  return { frames, hop: hop / sr, t0: size / 2 / sr };
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

/** Notes sounding at each chromagram frame, as pitch-class weights (shifted by `shift`). */
function noteChroma(notes: Note[], c: Chromagram, shift: number, timeOffset = 0): Array<Float32Array | null> {
  const out: Array<Float32Array | null> = c.frames.map(() => null);
  for (const n of notes) {
    const a = Math.max(0, Math.ceil((n.start + timeOffset - c.t0) / c.hop));
    const b = Math.min(c.frames.length - 1, Math.floor((n.start + n.duration + timeOffset - c.t0) / c.hop));
    for (let i = a; i <= b; i++) {
      const v = (out[i] ??= new Float32Array(12));
      v[((((Math.round(n.pitch) + shift) % 12) + 12) % 12)] += 1;
    }
  }
  return out;
}

/** Mean per-frame chroma correlation between notes and audio (−1..1). */
export function chromaAgreement(audio: Pcm | Chromagram, notes: Note[], shift = 0, timeOffset = 0): number {
  const c = 'frames' in audio ? audio : chromagram(audio);
  const nc = noteChroma(notes, c, shift, timeOffset);
  let s = 0;
  let n = 0;
  nc.forEach((v, i) => {
    if (!v) return;
    const r = corr(v, c.frames[i]);
    if (!Number.isNaN(r)) {
      s += r;
      n++;
    }
  });
  return n ? s / n : 0;
}

export interface AlignResult {
  /** Add to every pitch (semitone + octave). */
  shift: number;
  semitoneShift: number;
  octaveShift: number;
  /** Chroma agreement for each candidate semitone shift −6..+5. */
  semitoneScores: Record<number, number>;
  octaveScores: Record<number, number>;
  agreement: number;
}

/**
 * Find the pitch shift that makes `notes` agree with `audio` (same timeline).
 * Semitone by chroma correlation; octave by energy at the fundamental: the
 * lowest octave with strong energy wins (higher candidates only see harmonics).
 */
export function alignNotesToAudio(notes: Note[], audio: Pcm, opts: { timeOffset?: number } = {}): AlignResult {
  const c = chromagram(audio);
  const semitoneScores: Record<number, number> = {};
  let semitoneShift = 0;
  let bestScore = -Infinity;
  for (let sft = -6; sft <= 5; sft++) {
    semitoneScores[sft] = chromaAgreement(c, notes, sft, opts.timeOffset);
    if (semitoneScores[sft] > bestScore) [bestScore, semitoneShift] = [semitoneScores[sft], sft];
  }
  // octave: spectral energy at each candidate fundamental, relative to the local spectrum
  const mono = toMono(audio);
  const sr = audio.sampleRate;
  const octaveScores: Record<number, number> = { [-24]: 0, [-12]: 0, 0: 0, 12: 0, 24: 0 };
  const sample = notes.filter((n) => n.duration >= 0.1).slice(0, 400);
  for (const n of sample) {
    const a = Math.round((n.start + (opts.timeOffset ?? 0) + 0.02) * sr);
    const len = Math.min(Math.round(Math.min(n.duration - 0.03, 0.25) * sr), 8192);
    if (a < 0 || a + len > mono.length || len < 512) continue;
    const N = 1 << Math.ceil(Math.log2(len * 4));
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < len; i++) re[i] = mono[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
    fft(re, im);
    const mag = (k: number) => Math.hypot(re[k], im[k]);
    let mean = 0;
    for (let k = 1; k < N / 2; k++) mean += mag(k);
    mean /= N / 2;
    for (const o of Object.keys(octaveScores).map(Number)) {
      const f0 = 440 * Math.pow(2, (n.pitch + semitoneShift + o - 69) / 12);
      const k0 = Math.round((f0 * N) / sr);
      if (k0 < 2 || k0 >= N / 2 - 3) continue;
      let peak = 0;
      for (let k = k0 - 2; k <= k0 + 2; k++) peak = Math.max(peak, mag(k));
      octaveScores[o] += peak / (mean + 1e-12);
    }
  }
  const maxScore = Math.max(...Object.values(octaveScores));
  const octaveShift = maxScore > 0 ? Math.min(...Object.entries(octaveScores).filter(([, v]) => v >= 0.85 * maxScore).map(([k]) => Number(k))) : 0;
  return { shift: semitoneShift + octaveShift, semitoneShift, octaveShift, semitoneScores, octaveScores, agreement: semitoneScores[semitoneShift] };
}

/**
 * For notes that sound alone (no overlap within the track), how close is the
 * rendered audio to the written pitch? Returns errors in semitones (pitch class).
 */
export function pitchAccuracy(rendered: Pcm, notes: Note[], opts: { minDuration?: number } = {}): { checked: number; medianError: number; within50cents: number; medianSigned: number } {
  const errs: number[] = [];
  const signed: number[] = [];
  const minD = opts.minDuration ?? 0.12;
  for (const n of notes) {
    if (n.duration < minD) continue;
    if (notes.some((m) => m !== n && m.start < n.start + n.duration && m.start + m.duration > n.start)) continue;
    const a = n.start + 0.02;
    const r = detectRootPitch(slice(rendered, a, a + Math.min(0.2, n.duration - 0.04)), { minHz: 40, maxHz: 2500, threshold: 0.2 });
    if (r) {
      const d = ((((r.midi - n.pitch + 6) % 12) + 12) % 12) - 6;
      errs.push(Math.abs(d));
      signed.push(d);
    }
  }
  errs.sort((x, y) => x - y);
  signed.sort((x, y) => x - y);
  return {
    checked: errs.length,
    medianError: errs.length ? errs[errs.length >> 1] : NaN,
    within50cents: errs.length ? errs.filter((e) => e < 0.5).length / errs.length : 0,
    medianSigned: signed.length ? signed[signed.length >> 1] : NaN,
  };
}

/** Best time offset (s) and chroma agreement between two recordings (b shifted by offset matches a). */
export function compareRecordings(a: Pcm, b: Pcm, opts: { maxOffset?: number } = {}): { offset: number; agreement: number } {
  const ca = chromagram(a);
  const cb = chromagram(b);
  const maxLag = Math.round((opts.maxOffset ?? 2) / ca.hop);
  let best = { offset: 0, agreement: -1 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < ca.frames.length; i += 2) {
      const j = i + lag;
      if (j < 0 || j >= cb.frames.length) continue;
      const r = corr(ca.frames[i], cb.frames[j]);
      if (!Number.isNaN(r)) {
        s += r;
        n++;
      }
    }
    if (n > 10 && s / n > best.agreement) best = { offset: lag * ca.hop, agreement: s / n };
  }
  return best;
}
