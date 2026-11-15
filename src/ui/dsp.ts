/**
 * Client for the DSP worker: heavy work off the main thread so the UI stays
 * responsive. Falls back to the main thread where workers aren't available.
 */
import type { Pcm } from '../core/audio/pcm';
import { OPS, sourcesFor, type OpArgs, type OpName, type OpResult } from '../workers/ops';
import { loadPcm } from './store';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number, l?: string) => void };

let worker: Worker | null = null;
let failed = false;
const sent = new Set<string>();
const pending = new Map<number, Pending>();
let nextId = 1;

function getWorker(): Worker | null {
  if (failed || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('../workers/dsp.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data as { kind: string; callId: number; result?: unknown; message?: string; fraction?: number; label?: string };
        const p = pending.get(m.callId);
        if (!p) return;
        if (m.kind === 'progress') p.onProgress?.(m.fraction ?? 0, m.label);
        else {
          pending.delete(m.callId);
          if (m.kind === 'result') p.resolve(m.result);
          else p.reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        console.warn('DSP worker failed, using the main thread', e);
        failed = true;
        worker = null;
        sent.clear();
        for (const p of pending.values()) p.reject(new Error('worker crashed'));
        pending.clear();
      };
    } catch {
      failed = true;
      return null;
    }
  }
  return worker;
}

/** Run a heavy operation (in the worker when possible). */
export async function dsp<K extends OpName>(op: K, args: OpArgs<K>, onProgress?: (f: number, label?: string) => void): Promise<OpResult<K>> {
  const ids = sourcesFor(op, args as Record<string, unknown>);
  const w = getWorker();
  if (import.meta.env.DEV) (globalThis as unknown as { __otoDspMode?: string }).__otoDspMode = w ? 'worker' : 'main';
  if (!w) {
    const cache = new Map<string, Pcm>();
    for (const id of ids) cache.set(id, await loadPcm(id));
    return (OPS[op] as (a: unknown, c: unknown) => Promise<OpResult<K>>)(args, {
      source: (id: string) => cache.get(id)!,
      progress: (f: number, l?: string) => onProgress?.(f, l),
    });
  }
  for (const id of ids) {
    if (sent.has(id)) continue;
    const pcm = await loadPcm(id);
    // structured clone copies the samples; the main-thread cache keeps its own
    w.postMessage({ kind: 'source', id, pcm });
    sent.add(id);
  }
  const callId = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    w.postMessage({ kind: 'call', callId, op, args });
  }).catch(async (e) => {
    if ((e as Error).message === 'worker crashed') return dsp(op, args, onProgress); // retry on main thread
    throw e;
  }) as Promise<OpResult<K>>;
}

/** Forget a source in the worker (e.g. deleted from the library). */
export function dropSource(id: string) {
  sent.delete(id);
  worker?.postMessage({ kind: 'drop', id });
}
