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
  /** For separated stems: the asset this was separated from (same timeline). */
  derivedFrom?: Id;
  /** Stem name ('vocals', 'accompaniment', 'drums', 'bass', 'other'). */
  stem?: string;
  /** Cloud mode only. */
  visibility?: 'private' | 'unlisted' | 'public';
  ownerId?: string;
  ownerName?: string;
  status?: 'active' | 'removed';
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
  /** Auto-level: loudness relative to the other tracks, dB (e.g. +3 for the lead). */
  levelOffset?: number;
  effects?: Effect[];
}

/**
 * How a sample reacts to a note:
 * - resample: classic 音MAD pitching (speed + pitch change together, like a sampler)
 * - fixed:    no pitch change (drums, hits)
 * - natural:  pitch changes, speed and formants don't (PSOLA) — voices stay voices
 */
export type PitchMode = 'resample' | 'fixed' | 'natural';

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
  /** Pitch flattening ("tuning") strength 0..1 applied to the clip first. */
  flatten?: number;
  /** Take the sound from this asset instead (e.g. a separated vocals stem); the picture still comes from sourceId. */
  audioId?: Id;
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
  | 'normalize'
  | 'limiter';

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
  /** Note track that produced this event (synced events only). */
  trackId?: Id;
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
  /** Shake amplitude (fraction of the cell) at attack, decaying with punchDecay. */
  shake?: number;
  /** Extra zoom reached by the end of the sounding part (slow push-in). */
  zoomDrift?: number;
  /** Time after which the event is only holding its last frame (no longer sounding). */
  holdFrom?: number;
  /** Draw held frames in greyscale. */
  greyHeld?: boolean;
}

export type FlipMode = 'none' | 'alternate' | 'vertical' | 'both' | 'random';

/** A screen-wide hit (from the notes of a "pulse" track, e.g. the kick). */
export interface Pulse {
  time: number;
  strength: number;
}

export type VideoFxKind = 'mirror' | 'kaleido' | 'tile' | 'burst' | 'glass' | 'flash' | 'grade';

/**
 * A time-ranged whole-frame effect (applied after the video events, under the text):
 * - mirror:  symmetric halves (params.mode 0 = left→right, 1 = top→bottom, 2 = four quarters)
 * - kaleido: params.segments (even), params.spin (°/s), params.zoom
 * - tile:    params.n copies per side, alternate mirrored, params.spin (°/s), params.zoom
 * - burst:   radial speed lines (params.count, params.inner 0..1, params.alpha); colour in `color`
 * - glass:   shattered-glass rays from the centre (params.count, params.alpha)
 * - flash:   full-frame flash that decays (params.decay s, params.alpha); colour in `color`
 * - grade:   colour grade (params.saturate, contrast, brightness, hue °, tint alpha); tint colour in `color`
 */
export interface VideoFx {
  id: Id;
  kind: VideoFxKind;
  start: number;
  end: number;
  params: Record<string, number>;
  color?: string;
  /** Fade in/out (s), default 0.06. */
  fade?: number;
}

export interface TextOverlay {
  id: Id;
  text: string;
  start: number;
  end: number;
  /** Anchor position (0..1); x is the left/centre/right edge per align, y the text's centre. */
  x: number;
  y: number;
  /** Font size as a fraction of the video height. */
  size: number;
  color: string;
  stroke?: string;
  font?: 'sans' | 'serif' | 'mono' | 'rounded';
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  /** 'box' = background behind the text, 'card' = full-screen background (title card). */
  background?: 'none' | 'box' | 'card';
  backgroundColor?: string;
  anim?: 'none' | 'fade' | 'pop' | 'type' | 'slide';
}

export type SyncLayout = 'single' | 'grid' | 'columns' | 'rows';

/** A section of the video with its own layout. */
export interface VideoScene {
  id: Id;
  /** Start time in seconds; the scene lasts until the next one. */
  from: number;
  /** 'focus' = first track large on the left, the others in a grid on the right. */
  layout: SyncLayout | 'focus' | 'custom';
  /** Visible tracks in display order (first = focus). Tracks not listed are hidden. */
  order: Id[];
  /** Positions for 'custom' (normalised 0..1), by track id. */
  rects?: Record<Id, Rect>;
}

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
  /** Overrides alternateFlip when set. */
  flipMode?: FlipMode;
  /** Alternating rotation per note, degrees. */
  rotate?: number;
  /** Shake on attack (fraction of the cell). */
  shake?: number;
  /** Slow zoom-in over each note (e.g. 0.1 = +10 %). */
  zoomDrift?: number;
  /** Greyscale while a cell only holds its last frame. */
  greyHeld?: boolean;
  /** Tracks whose notes pulse the whole screen. */
  pulseTrackIds?: Id[];
  pulseFlash?: number;
  pulseZoom?: number;
  pulseShake?: number;
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
  /** Time (s) of a bar line: the editor grid and quantize are aligned to it. */
  gridOffset?: number;
  sampleRate: number;
  tracks: NoteTrack[];
  samples: Sample[];
  masterEffects: Effect[];
  videoSync: VideoSyncSettings;
  /** Track ids included in the video synchronizer (others are audio-only). */
  videoTrackIds?: Id[];
  /** Layout changes over time. Empty/undefined: one layout from videoSync for the whole video. */
  videoScenes?: VideoScene[];
  videoClips: VideoClip[];
  /** Text overlays and title cards. */
  texts?: TextOverlay[];
  /** Whole-frame effects over time (mirror, kaleidoscope, speed lines, grade…). */
  videoFx?: VideoFx[];
  /** Normalise the master to this loudness (LUFS), with a true-peak limiter. */
  masterLoudness?: number;
  /** Limiter ceiling for masterLoudness, dBFS (default −1). */
  masterCeiling?: number;
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
