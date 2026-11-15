/**
 * Heavy operations that can run in the DSP worker (or on the main thread as a
 * fallback). Inputs/outputs are plain data so they survive postMessage.
 */
import type { Pcm } from '../core/audio/pcm';
import type { Project } from '../core/types';
import { mixProject, autoLevel } from '../core/render/mix';
import { checkProject } from '../core/render/check';
import { findSyllables, type FinderOptions } from '../core/analysis/sampleFinder';
import { findDrumHits } from '../core/analysis/drums';

export interface OpContext {
  source(id: string): Pcm;
  progress(fraction: number, label?: string): void;
}

const loader = (ctx: OpContext) => async (id: string) => ctx.source(id);

export const OPS = {
  async mix(a: { project: Project }, ctx: OpContext) {
    const { master, loudness } = await mixProject(a.project, loader(ctx), { onProgress: (f, l) => ctx.progress(f, l) });
    return { master, loudness };
  },
  async autoLevel(a: { project: Project; targetLufs?: number }, ctx: OpContext) {
    return autoLevel(a.project, loader(ctx), { targetLufs: a.targetLufs });
  },
  async check(a: { project: Project; referenceId?: string }, ctx: OpContext) {
    return checkProject(a.project, loader(ctx), { reference: a.referenceId ? ctx.source(a.referenceId) : undefined, onProgress: (f) => ctx.progress(f) });
  },
  async findSyllables(a: { sourceId: string; opts?: FinderOptions }, ctx: OpContext) {
    return findSyllables(ctx.source(a.sourceId), a.opts);
  },
  async findDrumHits(a: { sourceId: string }, ctx: OpContext) {
    return findDrumHits(ctx.source(a.sourceId));
  },
};

export type OpName = keyof typeof OPS;
export type OpArgs<K extends OpName> = Parameters<(typeof OPS)[K]>[0];
export type OpResult<K extends OpName> = Awaited<ReturnType<(typeof OPS)[K]>>;

/** Source ids an op needs. */
export function sourcesFor(_op: OpName, args: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const p = args.project as Project | undefined;
  if (p) {
    for (const t of p.tracks) {
      const s = p.samples.find((x) => x.id === t.sampleId);
      if (s && !t.muted) ids.add(s.sourceId);
    }
    if (p.backingAudioId) ids.add(p.backingAudioId);
  }
  if (typeof args.sourceId === 'string') ids.add(args.sourceId);
  if (typeof args.referenceId === 'string') ids.add(args.referenceId);
  return [...ids];
}

/** All ArrayBuffers inside a result (to transfer instead of copy). */
export function transferables(x: unknown, out: Transferable[] = [], seen = new Set<unknown>()): Transferable[] {
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (ArrayBuffer.isView(x)) {
    if (!out.includes(x.buffer as ArrayBuffer)) out.push(x.buffer as ArrayBuffer);
    return out;
  }
  for (const v of Object.values(x as Record<string, unknown>)) transferables(v, out, seen);
  return out;
}
