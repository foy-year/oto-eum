/**
 * Loudness (ITU-R BS.1770-4 / EBU R128), true peak, and a look-ahead peak limiter.
 */
import { type Pcm, applyGain, clonePcm, lengthOf } from '../audio/pcm';
import { biquadCoefs } from './effects';

function biquadInPlace(x: Float32Array, c: ReturnType<typeof biquadCoefs>) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** K-weighting (pre-filter shelf + RLB high-pass), any sample rate. */
function kWeight(ch: Float32Array, sr: number): Float32Array {
  const y = new Float32Array(ch);
  biquadInPlace(y, biquadCoefs('highshelf', sr, 1681.974450955533, 0.7071752369554196, 3.999843853973347));
  biquadInPlace(y, biquadCoefs('highpass', sr, 38.13547087602444, 0.5003270373238773));
  return y;
}

export interface LoudnessResult {
  /** Integrated loudness, LUFS (−Infinity for silence). */
  integrated: number;
  /** Max short-term (3 s) loudness, LUFS. */
  shortTermMax: number;
  /** True peak, dBTP (4× oversampled). */
  truePeak: number;
}

export function measureLoudness(pcm: Pcm): LoudnessResult {
  const sr = pcm.sampleRate;
  const k = pcm.channels.map((c) => kWeight(c, sr));
  const n = lengthOf(pcm);
  // cumulative energy for fast block sums
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (const ch of k) e += ch[i] * ch[i];
    cum[i + 1] = cum[i] + e;
  }
  const blockMS = (from: number, len: number) => (cum[Math.min(n, from + len)] - cum[from]) / len;
  const L = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const blk = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const blocks: number[] = [];
  for (let s = 0; s + blk <= n; s += step) blocks.push(blockMS(s, blk));
  if (!blocks.length && n) blocks.push(blockMS(0, n));
  const abs = blocks.filter((z) => L(z) > -70);
  let integrated = -Infinity;
  if (abs.length) {
    const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((z) => L(z) > rel);
    if (gated.length) integrated = L(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
  let shortTermMax = -Infinity;
  const st = Math.round(3 * sr);
  for (let s = 0; s + st <= n; s += step) shortTermMax = Math.max(shortTermMax, L(blockMS(s, st)));
  if (n < st && n) shortTermMax = L(blockMS(0, n));
  return { integrated, shortTermMax, truePeak: truePeakDb(pcm) };
}

/** 4× oversampled peak (windowed-sinc interpolation), dBTP. */
export function truePeakDb(pcm: Pcm): number {
  const taps = 12; // per side
  const phases = [0.25, 0.5, 0.75].map((f) => {
    const h: number[] = [];
    for (let k = -taps + 1; k <= taps; k++) {
      const t = k - f;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (taps + 1));
      h.push(sinc * w);
    }
    return h;
  });
  let peak = 0;
  for (const x of pcm.channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
      // only interpolate around samples that are already near the peak (fast)
      if (a < peak * 0.7) continue;
      for (const h of phases) {
        let s = 0;
        for (let k = -taps + 1, j = 0; k <= taps; k++, j++) s += (x[i + k] ?? 0) * h[j];
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Look-ahead peak limiter: no sample above `ceilingDb`, smooth gain changes. */
export function limit(pcm: Pcm, ceilingDb = -1, opts: { lookahead?: number; release?: number } = {}): Pcm {
  const sr = pcm.sampleRate;
  const ceil = Math.pow(10, ceilingDb / 20);
  const n = lengthOf(pcm);
  const L = Math.max(1, Math.round((opts.lookahead ?? 0.005) * sr));
  const rc = 1 - Math.exp(-1 / ((opts.release ?? 0.08) * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of pcm.channels) p = Math.max(p, Math.abs(ch[i]));
    req[i] = p > ceil ? ceil / p : 1;
  }
  // min over the next L samples (monotonic deque)
  const mn = new Float32Array(n);
  const dq: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && req[dq[dq.length - 1]] >= req[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + L) dq.shift();
    mn[i] = req[dq[0]];
  }
  // smooth the attack (moving average over L), then release
  const g = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += mn[i];
    if (i >= L) acc -= mn[i - L];
    const avg = acc / Math.min(i + 1, L);
    const target = Math.min(avg, req[i]);
    const prev = i ? g[i - 1] : 1;
    g[i] = target < prev ? target : prev + (target - prev) * rc;
  }
  const out = clonePcm(pcm);
  for (const ch of out.channels) for (let i = 0; i < n; i++) ch[i] *= Math.min(g[i], req[i]);
  return out;
}

/** Bring a mix to `targetLufs`, then limit peaks to `ceilingDb`. */
export function normalizeLoudness(pcm: Pcm, targetLufs = -14, ceilingDb = -1): { pcm: Pcm; gainDb: number; before: number } {
  const before = measureLoudness(pcm).integrated;
  if (!Number.isFinite(before)) return { pcm, gainDb: 0, before };
  const gainDb = Math.max(-40, Math.min(40, targetLufs - before));
  return { pcm: limit(applyGain(pcm, Math.pow(10, gainDb / 20)), ceilingDb), gainDb, before };
}

/** Loudness of the audible part of a stem (blocks above −70 LUFS, relative gate). */
export function stemLoudness(pcm: Pcm): number {
  return measureLoudness(pcm).integrated;
}
