/// <reference lib="webworker" />
/** Runs HTDemucs off the main thread; keeps the session between runs. */
import { HTDemucs, separateStems } from '../core/analysis/demucs';
import type { Pcm } from '../core/audio/pcm';
import { transferables } from './ops';

declare const self: DedicatedWorkerGlobalScope;
let model: HTDemucs | null = null;
let modelKey = '';

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { kind: 'separate'; callId: number; key: string; model?: ArrayBuffer; wasmBase?: string; pcm: Pcm };
  try {
    if (!model || modelKey !== m.key) {
      if (!m.model) throw new Error('model bytes needed');
      self.postMessage({ kind: 'progress', callId: m.callId, fraction: 0, label: 'Loading model…' });
      model = await HTDemucs.load(m.model, m.wasmBase);
      modelKey = m.key;
    }
    const stems = await separateStems(model, m.pcm, (f) => self.postMessage({ kind: 'progress', callId: m.callId, fraction: f, label: `Separating (${model!.backend})…` }));
    self.postMessage({ kind: 'result', callId: m.callId, result: { stems, backend: model.backend } }, transferables(stems));
  } catch (err) {
    self.postMessage({ kind: 'error', callId: m.callId, message: (err as Error).message ?? String(err) });
  }
};
