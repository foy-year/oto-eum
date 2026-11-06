/**
 * Onset & tempo detection (spectral flux + adaptive peak picking).
 *
 * Uses: auto-slicing a source into samples, snapping video cuts to the beat,
 * estimating BPM for quantisation.
 */
import { type Pcm, toMono, resample } from '../audio/pcm';
import { stft } from './fft';

export interface OnsetOptions {
  analysisRate?: number;
  size?: number;
  hop?: number;
  /** Peak must exceed local mean by this factor * local stddev. */
  sensitivity?: number;
  /** Minimum distance between onsets, seconds. */
  minInterval?: number;
}

export interface OnsetResult {
  onsets: number[];
  /** Normalised onset strength envelope (one value per hop). */
  envelope: Float32Array;
  envelopeRate: number;
}

export function detectOnsets(pcm: Pcm, opts: OnsetOptions = {}): OnsetResult {
  const rate = opts.analysisRate ?? 22050;
  const size = opts.size ?? 1024;
  const hop = opts.hop ?? 256;
  const sens = opts.sensitivity ?? 1.5;
  const minInterval = opts.minInterval ?? 0.05;
  const x = resample({ sampleRate: pcm.sampleRate, channels: [toMono(pcm)] }, Math.min(rate, pcm.sampleRate));
  const spec = stft(x.channels[0], size, hop);
  const env = new Float32Array(spec.length);
  for (let f = 1; f < spec.length; f++) {
    let flux = 0;
    const a = spec[f];
    const b = spec[f - 1];
    for (let k = 0; k < a.length; k++) {
      // log-compressed magnitude, half-wave rectified difference
      const d = Math.log1p(100 * a[k]) - Math.log1p(100 * b[k]);
      if (d > 0) flux += d;
    }
    env[f] = flux;
  }
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < env.length; i++) env[i] /= max;

  const envRate = x.sampleRate / hop;
  const w = Math.max(3, Math.round(0.1 * envRate));
  const onsets: number[] = [];
  const minFrames = Math.round(minInterval * envRate);
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    const a = Math.max(0, i - w);
    const b = Math.min(env.length, i + w + 1);
    let mean = 0;
    for (let j = a; j < b; j++) mean += env[j];
    mean /= b - a;
    let v = 0;
    for (let j = a; j < b; j++) v += (env[j] - mean) ** 2;
    const sd = Math.sqrt(v / (b - a));
    if (env[i] > mean + sens * sd && env[i] > 0.05 && i - last >= minFrames) {
      // Frame-centre time. The windowed flux rises slightly before the true
      // transient (~10 ms early), which is a useful pre-roll when slicing.
      onsets.push(Math.max(0, (i * hop + size / 2) / x.sampleRate));
      last = i;
    }
  }
  return { onsets, envelope: env, envelopeRate: envRate };
}

/** Autocorrelation tempo estimate from an onset envelope. */
export function estimateTempo(res: OnsetResult, minBpm = 70, maxBpm = 200): { bpm: number; confidence: number } {
  const env = res.envelope;
  const r = res.envelopeRate;
  const minLag = Math.floor((60 / maxBpm) * r);
  const maxLag = Math.ceil((60 / minBpm) * r);
  let best = 0;
  let bestLag = minLag;
  let sum = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    s /= env.length - lag || 1;
    sum += s;
    count++;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // parabolic refine
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    return s / (env.length - lag || 1);
  };
  const y0 = ac(bestLag - 1);
  const y2 = ac(bestLag + 1);
  const den = y0 - 2 * best + y2;
  const lag = den !== 0 ? bestLag + (0.5 * (y0 - y2)) / den : bestLag;
  const mean = sum / Math.max(1, count);
  return { bpm: (60 * r) / lag, confidence: mean > 0 ? Math.min(1, (best - mean) / best) : 0 };
}

/**
 * Split a source into regions at onsets (for auto-creating samples from a
 * spoken line, a drum loop, etc).
 */
export function sliceAtOnsets(duration: number, onsets: number[], minLen = 0.05): Array<{ start: number; end: number }> {
  const pts = [...onsets.filter((t) => t > 0 && t < duration), duration];
  const out: Array<{ start: number; end: number }> = [];
  let s = 0;
  for (const p of pts) {
    if (p - s >= minLen) {
      out.push({ start: s, end: p });
      s = p;
    }
  }
  return out;
}
