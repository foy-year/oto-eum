/**
 * Monophonic pitch tracking (YIN, de Cheveigné & Kawahara 2002) and helpers to
 * turn an f0 contour into notes. Used for:
 *  - detecting the root pitch of a sample (so it can be tuned to MIDI notes)
 *  - fast monophonic MIDI extraction (vocals, speech "tuning", lead lines)
 */
import { type Pcm, toMono, resample } from '../audio/pcm';
import { type Note, uid } from '../types';

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(m: number): string {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}
export function nameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const base = NOTE_NAMES.indexOf(m[1].toUpperCase());
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}

export interface PitchFrame {
  time: number;
  /** Hz, or 0 when unvoiced. */
  f0: number;
  /** 0..1, 1 - YIN aperiodicity. */
  confidence: number;
  rms: number;
}

export interface YinOptions {
  minHz?: number;
  maxHz?: number;
  /** YIN absolute threshold (lower = stricter). */
  threshold?: number;
  hop?: number;
  frameSize?: number;
  /** Analysis sample rate; audio is resampled to it for speed. */
  analysisRate?: number;
  /** Frames quieter than this RMS are unvoiced. */
  silence?: number;
}

/** Estimate f0 of a single frame. Returns [hz, confidence]. */
export function yinFrame(buf: Float32Array, sampleRate: number, minHz: number, maxHz: number, threshold: number): [number, number] {
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(buf.length / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const W = buf.length - maxTau;
  if (W <= 0 || maxTau <= minTau) return [0, 0];
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = buf[i] - buf[i + tau];
      s += x * x;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // no dip under threshold: take global minimum but report low confidence
    let best = minTau;
    for (let t = minTau; t <= maxTau; t++) if (cmnd[t] < cmnd[best]) best = t;
    tau = best;
    if (cmnd[best] > 0.5) return [0, Math.max(0, 1 - cmnd[best])];
  }
  // parabolic interpolation
  let betterTau = tau;
  if (tau > 1 && tau < maxTau) {
    const s0 = cmnd[tau - 1];
    const s1 = cmnd[tau];
    const s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }
  return [sampleRate / betterTau, Math.max(0, Math.min(1, 1 - cmnd[tau]))];
}

export function trackPitch(pcm: Pcm, opts: YinOptions = {}): PitchFrame[] {
  const minHz = opts.minHz ?? 60;
  const maxHz = opts.maxHz ?? 1500;
  const threshold = opts.threshold ?? 0.15;
  const analysisRate = opts.analysisRate ?? 16000;
  const silence = opts.silence ?? 0.01;
  const mono = { sampleRate: pcm.sampleRate, channels: [toMono(pcm)] };
  const a = resample(mono, Math.min(analysisRate, pcm.sampleRate));
  const sr = a.sampleRate;
  const x = a.channels[0];
  const frameSize = opts.frameSize ?? Math.max(1024, nextPow2(Math.ceil((sr / minHz) * 2.2)));
  const hop = opts.hop ?? Math.round(sr * 0.01);
  const frames: PitchFrame[] = [];
  for (let start = 0; start + frameSize <= x.length; start += hop) {
    const frame = x.subarray(start, start + frameSize);
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    const r = Math.sqrt(e / frame.length);
    const time = (start + frameSize / 2) / sr;
    if (r < silence) {
      frames.push({ time, f0: 0, confidence: 0, rms: r });
      continue;
    }
    const [f0, conf] = yinFrame(frame, sr, minHz, maxHz, threshold);
    frames.push({ time, f0: conf > 0.5 ? f0 : 0, confidence: conf, rms: r });
  }
  return frames;
}

/**
 * Detect the dominant pitch of a (short) sample — the value you set as
 * `rootPitch` so the Sound Applier can retune it. Returns MIDI (fractional).
 */
export function detectRootPitch(pcm: Pcm, opts: YinOptions = {}): { midi: number; hz: number; confidence: number } | null {
  const frames = trackPitch(pcm, opts).filter((f) => f.f0 > 0);
  if (frames.length === 0) return null;
  // energy-weighted median in MIDI space (robust against octave blips)
  const items = frames.map((f) => ({ m: hzToMidi(f.f0), w: f.rms * f.confidence })).sort((p, q) => p.m - q.m);
  const total = items.reduce((s, i) => s + i.w, 0);
  let acc = 0;
  let med = items[0].m;
  for (const it of items) {
    acc += it.w;
    if (acc >= total / 2) {
      med = it.m;
      break;
    }
  }
  const conf = frames.reduce((s, f) => s + f.confidence, 0) / frames.length;
  return { midi: med, hz: midiToHz(med), confidence: conf };
}

export interface SegmentOptions {
  /** Minimum note length, seconds. */
  minDuration?: number;
  /** Semitone distance that splits a note. */
  splitThreshold?: number;
  /** Gaps shorter than this inside a note are bridged. */
  maxGap?: number;
  /** Snap note pitch to the nearest semitone. */
  quantizePitch?: boolean;
}

/** Group a pitch contour into discrete notes (monophonic transcription). */
export function framesToNotes(frames: PitchFrame[], opts: SegmentOptions = {}): Note[] {
  const minDuration = opts.minDuration ?? 0.06;
  const split = opts.splitThreshold ?? 0.75;
  const maxGap = opts.maxGap ?? 0.03;
  const q = opts.quantizePitch ?? true;
  const notes: Note[] = [];
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;
  // median-smooth MIDI contour (5 frames) to remove single-frame octave errors
  const midi = frames.map((f) => (f.f0 > 0 ? hzToMidi(f.f0) : NaN));
  const smooth = midi.map((_, i) => {
    const win = midi.slice(Math.max(0, i - 2), i + 3).filter((v) => !Number.isNaN(v));
    if (Number.isNaN(midi[i]) || win.length === 0) return NaN;
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });

  let cur: { start: number; end: number; pitches: number[]; amp: number[] } | null = null;
  let gap = 0;
  const flush = () => {
    if (!cur) return;
    const dur = cur.end - cur.start;
    if (dur >= minDuration) {
      const sorted = cur.pitches.slice().sort((a, b) => a - b);
      const p = sorted[Math.floor(sorted.length / 2)];
      const maxAmp = Math.max(...cur.amp);
      notes.push({ id: uid('n'), pitch: q ? Math.round(p) : p, start: cur.start, duration: dur, velocity: Math.min(1, 0.3 + maxAmp * 4) });
    }
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const m = smooth[i];
    const t = frames[i].time - hop / 2;
    if (Number.isNaN(m)) {
      if (cur) {
        gap += hop;
        if (gap > maxGap) flush();
      }
      continue;
    }
    if (cur) {
      const ref = cur.pitches.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, cur.pitches.length);
      if (Math.abs(m - ref) > split) {
        cur.end = t;
        flush();
      }
    }
    if (!cur) cur = { start: t, end: t + hop, pitches: [], amp: [] };
    cur.pitches.push(m);
    cur.amp.push(frames[i].rms);
    cur.end = t + hop;
    gap = 0;
  }
  flush();
  return notes;
}

function nextPow2(n: number) {
  return 1 << Math.ceil(Math.log2(n));
}
