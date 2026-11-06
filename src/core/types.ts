/**
 * Shared data model for the oto-eum toolkit.
 *
 * Everything here is plain, JSON-serialisable data so that projects can be
 * persisted (IndexedDB today, a server later) and processed in workers/tests.
 * All times are in SECONDS unless a field name says otherwise.
 */

export type Id = string;

/** An uploaded audio or video file. The binary lives in the media store. */
export interface MediaAsset {
  id: Id;
  name: string;
  kind: 'audio' | 'video';
  mime: string;
  size: number;
  duration: number;
  width?: number;
  height?: number;
  /** Detected/declared video frame rate, used to quantise frame lookups. */
  fps?: number;
  createdAt: number;
}

/** A single MIDI-like note. `pitch` is a MIDI note number (69 = A4 = 440 Hz). */
export interface Note {
  id: Id;
  pitch: number;
  start: number;
  duration: number;
  /** 0..1 */
  velocity: number;
}

export interface NoteTrack {
  id: Id;
  name: string;
  notes: Note[];
  /** Sample (sound clip) that this track triggers in the Sound Applier. */
  sampleId?: Id;
  muted?: boolean;
  /** Linear gain applied to the whole rendered track. */
  gain?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  effects?: Effect[];
}

/**
 * How a sample reacts to a note:
 * - resample: classic 音MAD pitching (speed + pitch change together, like a sampler)
 * - fixed:    no pitch change (drums, hits)
 */
export type PitchMode = 'resample' | 'fixed';

/**
 * What happens when the note is shorter/longer than the sample:
 * - cut:  stop at note end (with a tiny release)
 * - full: always play the whole sample (one-shot)
 * - loop: loop the sample region until the note ends
 */
export type SustainMode = 'cut' | 'full' | 'loop';

/** A non-destructive region of a media asset, used as an instrument. */
export interface Sample {
  id: Id;
  name: string;
  sourceId: Id;
  start: number;
  end: number;
  /** MIDI pitch the clip sounds at when played at its original speed. */
  rootPitch: number;
  /** Fine tuning of the root, in cents. */
  rootCents?: number;
  gain: number;
  reverse: boolean;
  fadeIn: number;
  fadeOut: number;
  pitchMode: PitchMode;
  sustain: SustainMode;
  /** Release tail applied in 'cut'/'loop' modes, seconds. */
  release?: number;
  /** Effects baked into the sample before it is triggered. */
  effects?: Effect[];
}

export type EffectType =
  | 'gain'
  | 'pan'
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'distortion'
  | 'bitcrush'
  | 'delay'
  | 'reverb'
  | 'chorus'
  | 'compressor'
  | 'tremolo'
  | 'stutter'
  | 'reverse'
  | 'speed'
  | 'normalize';

export interface Effect {
  id: Id;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One rendered piece of video on the timeline. Both the manual Video Editor and
 * the MIDI-driven Video Synchronizer compile down to a list of these.
 */
export interface VideoEvent {
  sourceId: Id;
  /** Timeline start/end. */
  start: number;
  end: number;
  /** Source time shown at `start`. */
  sourceIn: number;
  /** Source playback speed (pitch ratio in 'resample' mode). */
  rate: number;
  /** If set, the source region loops / holds inside [sourceIn, sourceLoopEnd]. */
  sourceLoopEnd?: number;
  /** 'hold' freezes on the last frame, 'loop' wraps, 'none' disappears. */
  overrun?: 'hold' | 'loop' | 'none';
  reverse?: boolean;
  /** Higher layers draw on top. */
  layer: number;
  /** Normalised (0..1) destination rectangle on the output canvas. */
  rect: Rect;
  flipX?: boolean;
  flipY?: boolean;
  /** Degrees. */
  hue?: number;
  opacity?: number;
  /** Extra scale at attack that decays over `punchDecay` seconds (1 = none). */
  punch?: number;
  punchDecay?: number;
  /** Fade out over the last N seconds of the event. */
  fadeOut?: number;
  /** Brightness flash at attack, 0..1. */
  flash?: number;
  invert?: boolean;
  rotate?: number;
}

export type SyncLayout = 'single' | 'grid' | 'columns' | 'rows';

export interface VideoSyncSettings {
  width: number;
  height: number;
  fps: number;
  layout: SyncLayout;
  /** Mirror every other note (the classic 音MAD left/right flip). */
  alternateFlip: boolean;
  /** Map pitch to hue rotation. */
  hueByPitch: boolean;
  /** Zoom punch on note attack (1 = off). */
  punch: number;
  flash: number;
  /** When a track's note ends, keep showing its last frame instead of black. */
  holdLastFrame: boolean;
  background: string;
}

/** A manually placed clip in the Video Editor. */
export interface VideoClip {
  id: Id;
  sourceId: Id;
  start: number;
  sourceIn: number;
  sourceOut: number;
  rate: number;
  layer: number;
  rect: Rect;
  flipX?: boolean;
  flipY?: boolean;
  hue?: number;
  opacity?: number;
  reverse?: boolean;
  invert?: boolean;
}

export interface Project {
  id: Id;
  name: string;
  bpm: number;
  sampleRate: number;
  tracks: NoteTrack[];
  samples: Sample[];
  masterEffects: Effect[];
  videoSync: VideoSyncSettings;
  /** Track ids included in the video synchronizer (others are audio-only). */
  videoTrackIds?: Id[];
  videoClips: VideoClip[];
  /** Optional backing audio (e.g. the original song) mixed under the render. */
  backingAudioId?: Id;
  backingGain?: number;
}

export function uid(prefix = ''): Id {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return prefix + Date.now().toString(36) + rnd;
}
