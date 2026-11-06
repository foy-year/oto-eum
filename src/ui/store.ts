import { create } from 'zustand';
import { type MediaAsset, type Project, type NoteTrack, type Sample, type Effect, uid } from '../core/types';
import { createProject } from '../core/project';
import { IdbMediaStore, IdbProjectStore } from '../core/storage/mediaStore';
import { assetFromProbe, decodeAudio, probeMedia } from '../core/audio/decode';
import { type Pcm, durationOf } from '../core/audio/pcm';
import { encodeWav } from '../core/audio/wav';

export const media = new IdbMediaStore();
export const projects = new IdbProjectStore();

// Decoded audio cache (not in React state: large typed arrays).
const pcmCache = new Map<string, Promise<Pcm>>();
export function loadPcm(id: string): Promise<Pcm> {
  let p = pcmCache.get(id);
  if (!p) {
    p = media.getBlob(id).then(decodeAudio);
    p.catch(() => pcmCache.delete(id));
    pcmCache.set(id, p);
  }
  return p;
}

export type Tab = 'library' | 'sound' | 'extract' | 'midi' | 'apply' | 'fx' | 'sync' | 'video';

interface State {
  project: Project;
  assets: MediaAsset[];
  tab: Tab;
  selectedAssetId?: string;
  selectedTrackId?: string;
  selectedSampleId?: string;
  busy?: string;
  error?: string;
  setTab(t: Tab): void;
  select(p: Partial<Pick<State, 'selectedAssetId' | 'selectedTrackId' | 'selectedSampleId'>>): void;
  setBusy(msg?: string): void;
  setError(msg?: string): void;
  init(): Promise<void>;
  upload(files: FileList | File[]): Promise<void>;
  addPcmAsset(name: string, pcm: Pcm): Promise<MediaAsset>;
  removeAsset(id: string): Promise<void>;
  update(fn: (p: Project) => Project | void): void;
  updateTrack(id: string, patch: Partial<NoteTrack>): void;
  updateSample(id: string, patch: Partial<Sample>): void;
  addTrack(t: NoteTrack): void;
  addSample(s: Sample): void;
  removeTrack(id: string): void;
  removeSample(id: string): void;
  setEffects(target: EffectTarget, fx: Effect[]): void;
  newProject(): void;
  loadProject(id: string): Promise<void>;
}

export type EffectTarget = { kind: 'master' } | { kind: 'track'; id: string } | { kind: 'sample'; id: string };

const LAST_KEY = 'oto-eum:lastProject';
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  project: createProject(),
  assets: [],
  tab: 'library',
  setTab: (tab) => set({ tab }),
  select: (p) => set(p),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),

  async init() {
    const assets = await media.list();
    let project: Project | undefined;
    try {
      const last = localStorage.getItem(LAST_KEY);
      if (last) project = await projects.load(last);
    } catch {
      /* storage unavailable */
    }
    set({ assets, ...(project ? { project } : {}) });
  },

  async upload(files) {
    const list = Array.from(files);
    for (const file of list) {
      set({ busy: `Importing ${file.name}…` });
      try {
        const probe = await probeMedia(file);
        const asset = assetFromProbe(uid('m'), file, file.name, probe);
        if (!probe.hasAudio && probe.kind === 'video') asset.name += ' (no audio)';
        await media.put(asset, file);
        set((s) => ({ assets: [...s.assets, asset], selectedAssetId: asset.id }));
      } catch (e) {
        set({ error: `${file.name}: ${(e as Error).message}` });
      }
    }
    set({ busy: undefined });
  },

  async addPcmAsset(name, pcm) {
    const blob = new Blob([encodeWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
    const asset: MediaAsset = { id: uid('m'), name, kind: 'audio', mime: 'audio/wav', size: blob.size, duration: durationOf(pcm), createdAt: Date.now() };
    await media.put(asset, blob);
    pcmCache.set(asset.id, Promise.resolve(pcm));
    set((s) => ({ assets: [...s.assets, asset] }));
    return asset;
  },

  async removeAsset(id) {
    await media.remove(id);
    pcmCache.delete(id);
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id), selectedAssetId: s.selectedAssetId === id ? undefined : s.selectedAssetId }));
  },

  update(fn) {
    const draft = structuredClone(get().project);
    const next = fn(draft) ?? draft;
    set({ project: next });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      projects.save(get().project).catch(() => {});
      try {
        localStorage.setItem(LAST_KEY, get().project.id);
      } catch {
        /* ignore */
      }
    }, 400);
  },
  updateTrack: (id, patch) => get().update((p) => void (p.tracks = p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)))),
  updateSample: (id, patch) => get().update((p) => void (p.samples = p.samples.map((s) => (s.id === id ? { ...s, ...patch } : s)))),
  addTrack: (t) => {
    get().update((p) => void p.tracks.push(t));
    set({ selectedTrackId: t.id });
  },
  addSample: (s) => {
    get().update((p) => void p.samples.push(s));
    set({ selectedSampleId: s.id });
  },
  removeTrack: (id) => get().update((p) => void (p.tracks = p.tracks.filter((t) => t.id !== id))),
  removeSample: (id) =>
    get().update((p) => {
      p.samples = p.samples.filter((s) => s.id !== id);
      p.tracks = p.tracks.map((t) => (t.sampleId === id ? { ...t, sampleId: undefined } : t));
    }),
  setEffects: (target, fx) =>
    get().update((p) => {
      if (target.kind === 'master') p.masterEffects = fx;
      else if (target.kind === 'track') p.tracks = p.tracks.map((t) => (t.id === target.id ? { ...t, effects: fx } : t));
      else p.samples = p.samples.map((s) => (s.id === target.id ? { ...s, effects: fx } : s));
    }),
  newProject: () => {
    set({ project: createProject(), selectedTrackId: undefined, selectedSampleId: undefined });
    get().update(() => {});
  },
  async loadProject(id) {
    const p = await projects.load(id);
    if (p) set({ project: p });
  },
}));

export function download(data: Blob | Uint8Array, filename: string, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[\\/:*?"<>|]+/g, '_');
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Run an async job with the global busy indicator + error reporting. */
export async function job<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const { setBusy, setError } = useStore.getState();
  setBusy(label);
  setError(undefined);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    setError((e as Error).message ?? String(e));
    return undefined;
  } finally {
    setBusy(undefined);
  }
}
