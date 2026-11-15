/**
 * Voice/stem separation from the UI: built-in (DSP worker) or neural
 * HTDemucs (its own worker, model file supplied by the user and kept in
 * IndexedDB — the weights are personal/research-use only, so oto-eum
 * never ships them).
 */
import { createStore, del, get, set } from 'idb-keyval';
import type { Pcm } from '../core/audio/pcm';
import { dsp } from './dsp';
import { loadPcm } from './store';

const models = createStore('oto-eum-models', 'models');
const KEY = 'htdemucs';

export interface ModelInfo {
  name: string;
  size: number;
  addedAt: number;
}

export async function getModelInfo(): Promise<ModelInfo | null> {
  return ((await get<{ info: ModelInfo }>(KEY, models).catch(() => undefined))?.info ?? null) as ModelInfo | null;
}

export async function saveModel(file: Blob, name: string): Promise<ModelInfo> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  // ONNX files are protobuf: they start with field 1 (ir_version, varint) → 0x08
  if (head[0] !== 0x08) throw new Error('That does not look like an ONNX model file.');
  const info = { name, size: file.size, addedAt: Date.now() };
  await set(KEY, { info, blob: file }, models);
  return info;
}

export async function saveModelFromUrl(url: string, onProgress?: (f: number) => void): Promise<ModelInfo> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  return saveModel(new Blob(parts as BlobPart[]), url.split('/').pop() || 'model.onnx');
}

export async function removeModel() {
  await del(KEY, models);
}

let worker: Worker | null = null;
let workerModelKey = '';
let nextId = 1;

/** Neural 4-stem separation of an asset (drums, bass, other, vocals). */
export async function separateNeural(assetId: string, onProgress?: (f: number, label?: string) => void): Promise<{ stems: Record<string, Pcm>; backend: string }> {
  const rec = await get<{ info: ModelInfo; blob: Blob }>(KEY, models);
  if (!rec) throw new Error('Load a Demucs model file first.');
  const pcm = await loadPcm(assetId);
  worker ??= new Worker(new URL('../workers/separate.worker.ts', import.meta.url), { type: 'module' });
  const key = `${rec.info.name}:${rec.info.size}:${rec.info.addedAt}`;
  const model = workerModelKey === key ? undefined : await rec.blob.arrayBuffer();
  const callId = nextId++;
  const w = worker;
  const copy = { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => new Float32Array(c)) };
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data as { kind: string; callId: number; result?: { stems: Record<string, Pcm>; backend: string }; message?: string; fraction?: number; label?: string };
      if (m.callId !== callId) return;
      if (m.kind === 'progress') onProgress?.(m.fraction ?? 0, m.label);
      else if (m.kind === 'result') {
        workerModelKey = key;
        resolve(m.result!);
      } else reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'separation worker crashed (out of memory?)'));
    const transfer: Transferable[] = copy.channels.map((c) => c.buffer as ArrayBuffer);
    if (model) transfer.push(model);
    w.postMessage({ kind: 'separate', callId, key, model, pcm: copy }, transfer);
  });
}

/** Built-in separation (DSP worker): vocals + accompaniment. */
export async function separateBuiltIn(assetId: string, strength: number, onProgress?: (f: number) => void) {
  return dsp('separateVoice', { sourceId: assetId, strength }, onProgress);
}
