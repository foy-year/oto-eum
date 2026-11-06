/**
 * Sound Applier engine: plays a Sample at every note of a track.
 *
 * Pure JS, sample-accurate and deterministic, so the exact same schedule drives
 * both the audio render and the video synchronizer (see `noteRate`).
 */
import { type Pcm, createPcm, lengthOf, slice, reverse, fade, applyGain, resample, withChannels, panPcm } from '../audio/pcm';
import type { Note, NoteTrack, Sample } from '../types';
import { applyEffects } from './effects';

/** Playback rate for a note given the sample's root (1 = original speed). */
export function noteRate(sample: Pick<Sample, 'rootPitch' | 'rootCents' | 'pitchMode'>, pitch: number): number {
  if (sample.pitchMode === 'fixed') return 1;
  const root = sample.rootPitch + (sample.rootCents ?? 0) / 100;
  return Math.pow(2, (pitch - root) / 12);
}

/** How long (timeline seconds) a sample sounds for a given note. */
export function voiceDuration(sample: Sample, note: Note, sampleLength: number): number {
  const rate = noteRate(sample, note.pitch);
  const natural = sampleLength / rate;
  const release = sample.release ?? 0.01;
  switch (sample.sustain) {
    case 'full':
      return natural;
    case 'loop':
      return note.duration + release;
    case 'cut':
    default:
      return Math.min(natural, note.duration + release);
  }
}

/** Resolve a Sample definition against its source audio → the clip actually played. */
export function prepareSample(source: Pcm, sample: Sample, targetRate?: number): Pcm {
  let clip = slice(source, sample.start, sample.end);
  if (sample.reverse) clip = reverse(clip);
  if (sample.effects?.length) clip = applyEffects(clip, sample.effects);
  clip = fade(clip, sample.fadeIn, sample.fadeOut);
  clip = applyGain(clip, sample.gain);
  if (targetRate && clip.sampleRate !== targetRate) clip = resample(clip, targetRate);
  return clip;
}

export interface RenderTrackOptions {
  sampleRate: number;
  channels?: number;
  /** Total output length in seconds (defaults to last voice end). */
  length?: number;
}

/**
 * Render one track: for each note, resample the clip at `noteRate` and mix it in.
 * Uses 4-point (cubic Hermite) interpolation for clean pitch-shifting.
 */
export function renderTrack(notes: Note[], clip: Pcm, sample: Sample, opts: RenderTrackOptions): Pcm {
  const sr = opts.sampleRate;
  const chs = opts.channels ?? 2;
  const src = withChannels(clip.sampleRate === sr ? clip : resample(clip, sr), chs);
  const srcLen = lengthOf(src);
  const srcDur = srcLen / sr;
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + voiceDuration(sample, n, srcDur));
  const out = createPcm(sr, chs, Math.ceil((opts.length ?? end) * sr));
  const outLen = lengthOf(out);
  const releaseS = Math.max(1, Math.round((sample.release ?? 0.01) * sr));
  const attackS = Math.max(1, Math.round(0.002 * sr)); // de-click

  for (const n of notes) {
    if (srcLen < 2) break;
    const rate = noteRate(sample, n.pitch);
    const dur = voiceDuration(sample, n, srcDur);
    const o0 = Math.round(n.start * sr);
    const count = Math.min(Math.round(dur * sr), outLen - o0);
    const noteEnd = Math.round(n.duration * sr);
    const gain = n.velocity;
    const loop = sample.sustain === 'loop';
    for (let c = 0; c < chs; c++) {
      const s = src.channels[c];
      const d = out.channels[c];
      for (let i = 0; i < count; i++) {
        let pos = i * rate;
        if (loop) pos %= srcLen - 1;
        else if (pos >= srcLen - 1) break;
        const v = hermite(s, pos);
        let env = gain;
        if (i < attackS) env *= i / attackS;
        if (sample.sustain !== 'full' && i > noteEnd) env *= Math.max(0, 1 - (i - noteEnd) / releaseS);
        const j = o0 + i;
        if (j >= 0) d[j] += v * env;
      }
    }
  }
  return out;
}

function hermite(s: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const xm1 = s[i - 1] ?? s[i];
  const x0 = s[i];
  const x1 = s[i + 1] ?? x0;
  const x2 = s[i + 2] ?? x1;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Convenience: render a full NoteTrack including its gain/pan/effects. */
export function renderNoteTrack(track: NoteTrack, sample: Sample, sourcePcm: Pcm, opts: RenderTrackOptions): Pcm {
  const clip = prepareSample(sourcePcm, sample, opts.sampleRate);
  let out = renderTrack(track.notes, clip, sample, opts);
  if (track.effects?.length) out = applyEffects(out, track.effects);
  out = applyGain(out, track.gain ?? 1);
  return panPcm(out, track.pan ?? 0);
}
