/**
 * Neural source separation (HTDemucs, 4 stems) with onnxruntime-web.
 * WebGPU when available, else WebAssembly (multi-threaded if the page is
 * cross-origin isolated). The model file is supplied by the user.
 */
import type * as Ort from 'onnxruntime-web';
// Loaded with a dynamic import so the bundler keeps onnxruntime in its own chunk: its
// WebAssembly threads start workers from that chunk's URL, which must contain only the runtime.
let ortP: Promise<typeof Ort> | null = null;
const loadOrt = () => (ortP ??= import('onnxruntime-web'));
import { separateTracks, type HTDemucsModel } from '../../vendor/demucs/apply.js';
import { type Pcm, resample, withChannels } from '../audio/pcm';

export type Stem = 'drums' | 'bass' | 'other' | 'vocals';

let configured = false;
/** wasmBase: only to host the runtime elsewhere; by default the bundler serves it next to the code. */
function configure(ort: typeof Ort, wasmBase?: string) {
  if (configured) return;
  if (wasmBase) ort.env.wasm.wasmPaths = wasmBase;
  const iso = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  ort.env.wasm.numThreads = iso ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  configured = true;
}

export class HTDemucs implements HTDemucsModel {
  sources = ['drums', 'bass', 'other', 'vocals'];
  audioChannels = 2;
  samplerate = 44100;
  segment = 7.8;
  backend = 'wasm';
  private session!: Ort.InferenceSession;
  private ort!: typeof Ort;

  static async load(model: ArrayBuffer | Uint8Array, wasmBase?: string, preferGpu = true): Promise<HTDemucs> {
    const ort = await loadOrt();
    configure(ort, wasmBase);
    const m = new HTDemucs();
    m.ort = ort;
    const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
    // only trust WebGPU if an adapter really exists (headless/blocked GPUs expose the API without one)
    let hasGpu = false;
    if (preferGpu && typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        hasGpu = !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter());
      } catch {
        hasGpu = false;
      }
    }
    // WebAssembly memory is capped at 4 GB: no arena / memory-pattern pre-allocation (much lower peak)
    const lean: Ort.InferenceSession.SessionOptions = { enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: 'all' };
    try {
      m.session = await ort.InferenceSession.create(bytes, { ...lean, executionProviders: hasGpu ? ['webgpu', 'wasm'] : ['wasm'] });
      m.backend = hasGpu ? 'webgpu' : 'wasm';
    } catch (e) {
      if (!hasGpu) throw e;
      m.session = await ort.InferenceSession.create(bytes, { ...lean, executionProviders: ['wasm'] });
      m.backend = 'wasm';
    }
    return m;
  }

  validLength(length: number) {
    const L = Math.floor(this.segment * this.samplerate);
    if (L < length) throw new Error(`segment ${length} longer than training length ${L}`);
    return L;
  }

  async forward(mix: { data: Float32Array; shape: readonly number[] }, magspec: { data: Float32Array; shape: readonly number[] }) {
    const [a, b] = this.session.inputNames;
    const T = this.ort.Tensor;
    const res = await this.session.run({ [a]: new T('float32', mix.data, mix.shape as number[]), [b]: new T('float32', magspec.data, magspec.shape as number[]) });
    const [x, xt] = this.session.outputNames;
    const outX = res[x].data as Float32Array;
    const outXt = res[xt].data as Float32Array;
    return {
      outX: { data: outX, shape: res[x].dims },
      outXt: { data: outXt, shape: res[xt].dims },
    };
  }
}

/** Separate a recording into drums / bass / other / vocals (at the input's sample rate). */
export async function separateStems(model: HTDemucs, pcm: Pcm, onProgress?: (f: number) => void): Promise<Record<Stem, Pcm>> {
  const x = withChannels(resample(pcm, model.samplerate), 2);
  const tracks = await separateTracks(model, { channelData: x.channels, sampleRate: model.samplerate }, (step, total) => onProgress?.(step / total));
  const out = {} as Record<Stem, Pcm>;
  for (const s of model.sources as Stem[]) {
    const t = tracks[s];
    out[s] = resample({ sampleRate: model.samplerate, channels: t.channelData.map((c) => new Float32Array(c)) }, pcm.sampleRate);
  }
  return out;
}
