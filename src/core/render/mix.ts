/** Full project audio mixdown: tracks → samples → effects → master. */
import { type Pcm, createPcm, mixInto, softClip, lengthOf } from '../audio/pcm';
import type { Project } from '../types';
import { renderNoteTrack } from './sampler';
import { applyEffects } from './effects';

export type SourceLoader = (sourceId: string) => Promise<Pcm>;

export interface MixOptions {
  /** Render only these tracks (solo). */
  trackIds?: string[];
  includeBacking?: boolean;
  onProgress?: (fraction: number, label: string) => void;
}

export interface MixResult {
  master: Pcm;
  /** Per-track stems (post track effects, pre master). */
  stems: Record<string, Pcm>;
}

export async function mixProject(project: Project, load: SourceLoader, opts: MixOptions = {}): Promise<MixResult> {
  const sr = project.sampleRate;
  let master = createPcm(sr, 2, 0);
  const stems: Record<string, Pcm> = {};
  const tracks = project.tracks.filter((t) => !t.muted && t.sampleId && (!opts.trackIds || opts.trackIds.includes(t.id)));
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    opts.onProgress?.(i / (tracks.length + 1), `Rendering ${t.name}`);
    const sample = project.samples.find((s) => s.id === t.sampleId);
    if (!sample) continue;
    const src = await load(sample.sourceId);
    const stem = renderNoteTrack(t, sample, src, { sampleRate: sr, channels: 2 });
    stems[t.id] = stem;
    master = mixInto(master, stem, 0);
  }
  if (opts.includeBacking !== false && project.backingAudioId) {
    const backing = await load(project.backingAudioId);
    master = mixInto(master, backing, 0, project.backingGain ?? 1);
  }
  opts.onProgress?.(tracks.length / (tracks.length + 1), 'Master effects');
  if (project.masterEffects.length) master = applyEffects(master, project.masterEffects);
  if (lengthOf(master) === 0) master = createPcm(sr, 2, sr * 0.1);
  opts.onProgress?.(1, 'Done');
  return { master: softClip(master), stems };
}
