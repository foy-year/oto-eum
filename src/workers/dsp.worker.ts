/// <reference lib="webworker" />
import type { Pcm } from '../core/audio/pcm';
import { OPS, transferables, type OpName } from './ops';

const sources = new Map<string, Pcm>();
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { kind: 'source'; id: string; pcm: Pcm } | { kind: 'drop'; id: string } | { kind: 'call'; callId: number; op: OpName; args: never };
  if (m.kind === 'source') {
    sources.set(m.id, m.pcm);
    return;
  }
  if (m.kind === 'drop') {
    sources.delete(m.id);
    return;
  }
  const ctx = {
    source(id: string) {
      const s = sources.get(id);
      if (!s) throw new Error(`source ${id} not loaded in worker`);
      return s;
    },
    progress(fraction: number, label?: string) {
      self.postMessage({ kind: 'progress', callId: m.callId, fraction, label });
    },
  };
  try {
    const result = await (OPS[m.op] as (a: unknown, c: typeof ctx) => Promise<unknown>)(m.args, ctx);
    self.postMessage({ kind: 'result', callId: m.callId, result }, transferables(result));
  } catch (err) {
    self.postMessage({ kind: 'error', callId: m.callId, message: (err as Error).message ?? String(err) });
  }
};
