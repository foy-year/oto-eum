/**
 * MIDI extraction from audio / video.
 *
 * Two engines:
 *  - 'poly'  : Spotify Basic Pitch (neural, polyphonic, runs in-browser via TF.js).
 *              Loaded lazily — TF.js is large.
 *  - 'mono'  : YIN pitch tracker — fast, dependency-free, great for vocals,
 *              speech-melody ("tuning" talk), lead lines.
 */
import { type Pcm, resample, toMono, slice } from '../audio/pcm';
import { framesToNotes, trackPitch, type SegmentOptions, type YinOptions } from '../analysis/pitch';
import { type Note, uid } from '../types';
import { mergeRepeats, filterNotes } from './midi';

export interface TranscribeOptions {
  engine: 'poly' | 'mono';
  /** Optional time window of the source to analyse. */
  start?: number;
  end?: number;
  // poly options (Basic Pitch defaults)
  onsetThreshold?: number;
  frameThreshold?: number;
  minNoteFrames?: number;
  minHz?: number;
  maxHz?: number;
  /** Extract only the top line ("melodia trick" + monophonize later). */
  melodiaTrick?: boolean;
  // mono options
  yin?: YinOptions;
  segment?: SegmentOptions;
  minVelocity?: number;
  onProgress?: (fraction: number) => void;
  /** URL of Basic Pitch model.json. */
  modelUrl?: string;
}

export async function transcribe(pcm: Pcm, opts: TranscribeOptions): Promise<Note[]> {
  const region = opts.start != null || opts.end != null ? slice(pcm, opts.start ?? 0, opts.end ?? Infinity) : pcm;
  const offset = opts.start ?? 0;
  let notes: Note[];
  if (opts.engine === 'mono') {
    opts.onProgress?.(0);
    const frames = trackPitch(region, { minHz: opts.minHz, maxHz: opts.maxHz, ...opts.yin });
    notes = framesToNotes(frames, opts.segment);
    opts.onProgress?.(1);
  } else {
    notes = await transcribePoly(region, opts);
  }
  notes = filterNotes(notes, { minVelocity: opts.minVelocity ?? 0 });
  return mergeRepeats(notes, 0.005).map((n) => ({ ...n, start: n.start + offset }));
}

type BasicPitchModule = typeof import('@spotify/basic-pitch');
let cached: { url: string; model: InstanceType<BasicPitchModule['BasicPitch']> } | null = null;

async function transcribePoly(pcm: Pcm, opts: TranscribeOptions): Promise<Note[]> {
  const bp = await import('@spotify/basic-pitch');
  const mono = resample({ sampleRate: pcm.sampleRate, channels: [toMono(pcm)] }, 22050).channels[0];
  const url = opts.modelUrl ?? defaultModelUrl();
  if (!cached || cached.url !== url) cached = { url, model: new bp.BasicPitch(url) };
  const model = cached.model;
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await model.evaluateModel(
    mono,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p) => opts.onProgress?.(p),
  );
  const raw = bp.outputToNotesPoly(
    frames,
    onsets,
    opts.onsetThreshold ?? 0.5,
    opts.frameThreshold ?? 0.3,
    opts.minNoteFrames ?? 5,
    true,
    opts.maxHz ?? null,
    opts.minHz ?? null,
    opts.melodiaTrick ?? true,
  );
  const timed = bp.noteFramesToTime(bp.addPitchBendsToNoteEvents(contours, raw));
  return timed.map((n) => ({
    id: uid('n'),
    pitch: n.pitchMidi,
    start: n.startTimeSeconds,
    duration: n.durationSeconds,
    velocity: Math.max(0.05, Math.min(1, n.amplitude)),
  }));
}

function defaultModelUrl(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}models/basic-pitch/model.json`;
}
