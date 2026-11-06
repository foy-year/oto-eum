/**
 * Video Synchronizer + Video Editor timeline model (pure, no DOM).
 *
 * The synchronizer turns every note of a sampled track into a VideoEvent that
 * plays the *same* source region as the audio, at the *same* rate. Because
 * `noteRate` is shared with the audio sampler, picture and sound stay
 * sample-locked — the core trick of 音MAD / YTPMV.
 */
import type { MediaAsset, Note, NoteTrack, Project, Rect, Sample, SyncLayout, VideoClip, VideoEvent, VideoSyncSettings } from '../types';
import { noteRate, voiceDuration } from '../render/sampler';
import { sortNotes, endTime } from '../midi/midi';

export const DEFAULT_SYNC: VideoSyncSettings = {
  width: 1280,
  height: 720,
  fps: 30,
  layout: 'grid',
  alternateFlip: true,
  hueByPitch: false,
  punch: 1.08,
  flash: 0.25,
  holdLastFrame: true,
  background: '#000000',
};

export function layoutRects(layout: SyncLayout, n: number): Rect[] {
  if (n <= 0) return [];
  const full = { x: 0, y: 0, w: 1, h: 1 };
  switch (layout) {
    case 'single':
      return Array.from({ length: n }, () => full);
    case 'columns':
      return Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0, w: 1 / n, h: 1 }));
    case 'rows':
      return Array.from({ length: n }, (_, i) => ({ x: 0, y: i / n, w: 1, h: 1 / n }));
    case 'grid':
    default: {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      return Array.from({ length: n }, (_, i) => {
        const r = Math.floor(i / cols);
        const inRow = r === rows - 1 ? n - r * cols : cols; // centre last row
        const c = i % cols;
        const w = 1 / cols;
        const xOff = (1 - inRow * w) / 2;
        return { x: xOff + c * w, y: r / rows, w, h: 1 / rows };
      });
    }
  }
}

export interface SyncInput {
  tracks: NoteTrack[];
  samples: Sample[];
  assets: Pick<MediaAsset, 'id' | 'kind' | 'duration'>[];
  settings: VideoSyncSettings;
  /** Restrict to these track ids (default: every track whose sample is a video). */
  trackIds?: string[];
  /** Total timeline length (for holding the final frame). */
  duration?: number;
}

export function videoTracksOf(input: Pick<SyncInput, 'tracks' | 'samples' | 'assets' | 'trackIds'>): NoteTrack[] {
  return input.tracks.filter((t) => {
    if (t.muted) return false;
    if (input.trackIds && !input.trackIds.includes(t.id)) return false;
    const s = input.samples.find((x) => x.id === t.sampleId);
    return !!s && input.assets.find((a) => a.id === s.sourceId)?.kind === 'video';
  });
}

export function buildSyncEvents(input: SyncInput): VideoEvent[] {
  const tracks = videoTracksOf(input);
  const rects = layoutRects(input.settings.layout, tracks.length);
  const total = input.duration ?? endTime(input.tracks);
  const st = input.settings;
  const events: VideoEvent[] = [];
  tracks.forEach((track, ti) => {
    const sample = input.samples.find((s) => s.id === track.sampleId)!;
    const len = sample.end - sample.start;
    const notes = sortNotes(track.notes);
    notes.forEach((n: Note, ni) => {
      const rate = noteRate(sample, n.pitch);
      const sounding = voiceDuration(sample, n, len);
      const next = notes.slice(ni + 1).find((m) => m.start > n.start + 1e-4);
      const end = st.holdLastFrame ? (next ? next.start : Math.max(total, n.start + sounding)) : n.start + sounding;
      if (end <= n.start) return;
      events.push({
        sourceId: sample.sourceId,
        start: n.start,
        end,
        sourceIn: sample.start,
        sourceLoopEnd: sample.end,
        rate,
        reverse: sample.reverse,
        overrun: sample.sustain === 'loop' ? 'loop' : 'hold',
        layer: st.layout === 'single' ? 0 : ti,
        rect: rects[ti],
        flipX: st.alternateFlip ? ni % 2 === 1 : false,
        hue: st.hueByPitch ? ((((n.pitch - sample.rootPitch) * 30) % 360) + 360) % 360 : 0,
        punch: st.punch,
        punchDecay: 0.12,
        flash: st.flash * n.velocity,
        opacity: 1,
      });
    });
  });
  return events;
}

export function clipsToEvents(clips: VideoClip[]): VideoEvent[] {
  return clips.map((c) => ({
    sourceId: c.sourceId,
    start: c.start,
    end: c.start + (c.sourceOut - c.sourceIn) / c.rate,
    sourceIn: c.sourceIn,
    sourceLoopEnd: c.sourceOut,
    rate: c.rate,
    reverse: c.reverse,
    overrun: 'hold',
    // manual clips sit above synced content by default
    layer: 1000 + c.layer,
    rect: c.rect,
    flipX: c.flipX,
    flipY: c.flipY,
    hue: c.hue,
    opacity: c.opacity ?? 1,
    invert: c.invert,
  }));
}

/** Source timestamp displayed by `ev` at timeline time `t`, or null if invisible. */
export function sourceTimeAt(ev: VideoEvent, t: number): number | null {
  if (t < ev.start || t >= ev.end) return null;
  const local = (t - ev.start) * ev.rate;
  const span = (ev.sourceLoopEnd ?? Infinity) - ev.sourceIn;
  let off = local;
  if (off >= span) {
    if (ev.overrun === 'loop' && span > 0) off = off % span;
    else if (ev.overrun === 'none') return null;
    else off = Math.max(0, span - 1e-3);
  }
  return ev.reverse && Number.isFinite(span) ? ev.sourceIn + span - off - 1e-3 : ev.sourceIn + off;
}

export interface ActiveEvent {
  ev: VideoEvent;
  sourceTime: number;
  /** Seconds since the event started. */
  age: number;
}

/** Events visible at `t`, in draw order (bottom → top). */
export function activeAt(events: VideoEvent[], t: number): ActiveEvent[] {
  const out: ActiveEvent[] = [];
  for (const ev of events) {
    const st = sourceTimeAt(ev, t);
    if (st != null) out.push({ ev, sourceTime: st, age: t - ev.start });
  }
  return out.sort((a, b) => a.ev.layer - b.ev.layer || a.ev.start - b.ev.start);
}

/** Per-frame visual modulation (zoom punch, flash, fade). */
export function visualState(a: ActiveEvent): { scale: number; flash: number; opacity: number } {
  const { ev, age } = a;
  const decay = ev.punchDecay ?? 0.12;
  const k = decay > 0 ? Math.exp(-age / decay) : 0;
  const scale = 1 + ((ev.punch ?? 1) - 1) * k;
  const flash = (ev.flash ?? 0) * k;
  let opacity = ev.opacity ?? 1;
  if (ev.fadeOut) opacity *= Math.min(1, Math.max(0, (ev.end - (ev.start + age)) / ev.fadeOut));
  return { scale, flash, opacity };
}

export function quantizeTime(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/**
 * All distinct (source, frame-time) pairs needed to render [t0, t1) at `fps`.
 * Used to pre-decode frames in sorted batches.
 */
export function framesNeeded(events: VideoEvent[], t0: number, t1: number, fps: number, sourceFps: (id: string) => number): Map<string, number[]> {
  const need = new Map<string, Set<number>>();
  const relevant = events.filter((e) => e.end > t0 && e.start < t1);
  for (let f = Math.floor(t0 * fps); f / fps < t1; f++) {
    for (const a of activeAt(relevant, f / fps)) {
      const set = need.get(a.ev.sourceId) ?? new Set<number>();
      set.add(quantizeTime(a.sourceTime, sourceFps(a.ev.sourceId)));
      need.set(a.ev.sourceId, set);
    }
  }
  return new Map([...need].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

export function projectVideoEvents(project: Project, assets: MediaAsset[], duration?: number): VideoEvent[] {
  return [
    ...buildSyncEvents({ tracks: project.tracks, samples: project.samples, assets, settings: project.videoSync, trackIds: project.videoTrackIds, duration }),
    ...clipsToEvents(project.videoClips),
  ];
}
