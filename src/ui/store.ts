import { create } from 'zustand';
import { type MediaAsset, type Project, type NoteTrack, type Sample, type Effect, uid } from '../core/types';
import { createProject } from '../core/project';
import { IdbMediaStore, IdbProjectStore, type MediaStore, type ProjectStore } from '../core/storage/mediaStore';
import { ApiClient, ConflictError, RemoteMediaStore, RemoteProjectStore, type CloudUser } from '../core/storage/remote';
import { assetFromProbe, decodeAudio, probeMedia } from '../core/audio/decode';
import { type Pcm, durationOf } from '../core/audio/pcm';
import { encodeWav } from '../core/audio/wav';

const localMedia = new IdbMediaStore();
const localProjects = new IdbProjectStore();
let mediaImpl: MediaStore = localMedia;
let projectImpl: ProjectStore = localProjects;
let api: ApiClient | null = null;

/** The active stores: local IndexedDB, or the oto-eum server when signed in. */
export const media: MediaStore = {
  list: () => mediaImpl.list(),
  put: (a, b) => mediaImpl.put(a, b),
  getBlob: (id) => mediaImpl.getBlob(id),
  getMeta: (id) => mediaImpl.getMeta(id),
  remove: (id) => mediaImpl.remove(id),
};
export const projects: ProjectStore = {
  list: () => projectImpl.list(),
  load: (id) => projectImpl.load(id),
  save: (p, force) => projectImpl.save(p, force),
  remove: (id) => projectImpl.remove(id),
};
export const cloudApi = () => api;

const CLOUD_KEY = 'oto-eum:cloud';
const DEFAULT_API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
export function savedCloud(): { url: string; token?: string } {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_KEY) ?? 'null') ?? { url: DEFAULT_API };
  } catch {
    return { url: DEFAULT_API };
  }
}

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

export type Tab = 'library' | 'sound' | 'extract' | 'midi' | 'apply' | 'fx' | 'sync' | 'video' | 'cloud';

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
  /** Cloud mode (null = local-only). */
  cloud: { url: string; user: CloudUser } | null;
  readOnly: boolean;
  conflict?: string;
  connectCloud(client: ApiClient, user: CloudUser): Promise<void>;
  disconnectCloud(): Promise<void>;
  refreshUser(): Promise<void>;
  refreshAssets(): Promise<void>;
  saveNow(force?: boolean): Promise<void>;
  reloadProject(): Promise<void>;
  migrateLocalToCloud(onProgress?: (msg: string) => void): Promise<number>;
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

  cloud: null,
  readOnly: false,

  async init() {
    const saved = savedCloud();
    if (saved.url && saved.token) {
      const client = new ApiClient(saved.url, saved.token);
      try {
        const user = await client.me();
        await get().connectCloud(client, user);
        return;
      } catch {
        // expired session or server down → fall back to local mode
      }
    }
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

  async connectCloud(client, user) {
    api = client;
    mediaImpl = new RemoteMediaStore(client);
    projectImpl = new RemoteProjectStore(client);
    pcmCache.clear();
    try {
      localStorage.setItem(CLOUD_KEY, JSON.stringify({ url: client.base, token: client.token }));
    } catch {
      /* ignore */
    }
    set({ cloud: { url: client.base, user }, conflict: undefined });
    await get().refreshAssets();
    // reopen the last cloud project, if any
    try {
      const last = localStorage.getItem(LAST_KEY + ':cloud');
      if (last) await get().loadProject(last);
    } catch {
      /* not found / no access */
    }
  },

  async disconnectCloud() {
    await api?.logout();
    api = null;
    mediaImpl = localMedia;
    projectImpl = localProjects;
    pcmCache.clear();
    try {
      localStorage.setItem(CLOUD_KEY, JSON.stringify({ url: savedCloud().url }));
    } catch {
      /* ignore */
    }
    set({ cloud: null, readOnly: false, conflict: undefined, assets: await localMedia.list() });
  },

  async refreshUser() {
    if (!api) return;
    const user = await api.me();
    set((s) => ({ cloud: s.cloud ? { ...s.cloud, user } : s.cloud }));
  },

  async refreshAssets() {
    set({ assets: await media.list() });
  },

  async saveNow(force = false) {
    const p = get().project;
    if (get().readOnly) return;
    try {
      const id = await projects.save(p, force);
      if (typeof id === 'string' && id !== p.id) set((s) => ({ project: { ...s.project, id } }));
      set({ conflict: undefined });
      try {
        localStorage.setItem(get().cloud ? LAST_KEY + ':cloud' : LAST_KEY, typeof id === 'string' ? id : p.id);
      } catch {
        /* ignore */
      }
    } catch (e) {
      if (e instanceof ConflictError) {
        const d = e.data as { updatedBy?: string };
        set({ conflict: `${e.message}${d.updatedBy ? ` (last saved by ${d.updatedBy})` : ''}.` });
      } else set({ error: `Saving failed: ${(e as Error).message}` });
    }
  },

  async reloadProject() {
    await get().loadProject(get().project.id);
    set({ conflict: undefined });
  },

  async migrateLocalToCloud(onProgress) {
    if (!api) throw new Error('Sign in first');
    const local = await localMedia.list();
    const idMap = new Map<string, string>();
    for (const [i, a] of local.entries()) {
      onProgress?.(`Uploading ${a.name} (${i + 1}/${local.length})…`);
      const stored = await media.put(a, await localMedia.getBlob(a.id));
      idMap.set(a.id, stored.id);
    }
    const remap = (id?: string) => (id && idMap.get(id)) || id;
    get().update((p) => {
      p.samples = p.samples.map((s) => ({ ...s, sourceId: remap(s.sourceId)! }));
      p.videoClips = p.videoClips.map((c) => ({ ...c, sourceId: remap(c.sourceId)! }));
      p.backingAudioId = remap(p.backingAudioId);
    });
    await get().saveNow();
    await get().refreshAssets();
    await get().refreshUser();
    return local.length;
  },

  async upload(files) {
    const list = Array.from(files);
    for (const file of list) {
      set({ busy: `Importing ${file.name}…` });
      try {
        const probe = await probeMedia(file);
        const asset = assetFromProbe(uid('m'), file, file.name, probe);
        if (!probe.hasAudio && probe.kind === 'video') asset.name += ' (no audio)';
        const stored = await media.put(asset, file);
        set((s) => ({ assets: [...s.assets.filter((a) => a.id !== stored.id), stored], selectedAssetId: stored.id }));
      } catch (e) {
        set({ error: `${file.name}: ${(e as Error).message}` });
      }
    }
    set({ busy: undefined });
  },

  async addPcmAsset(name, pcm) {
    const blob = new Blob([encodeWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
    const asset: MediaAsset = { id: uid('m'), name, kind: 'audio', mime: 'audio/wav', size: blob.size, duration: durationOf(pcm), createdAt: Date.now() };
    const stored = await media.put(asset, blob);
    pcmCache.set(stored.id, Promise.resolve(pcm));
    set((s) => ({ assets: [...s.assets.filter((a) => a.id !== stored.id), stored] }));
    return stored;
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
    // while a conflict is unresolved, don't keep hammering the server
    if (get().conflict) return;
    saveTimer = setTimeout(() => void get().saveNow(), get().cloud ? 1500 : 400);
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
    if (!p) return;
    const role = projectImpl instanceof RemoteProjectStore ? projectImpl.roles.get(id) : 'owner';
    set({ project: p, readOnly: role === 'viewer', conflict: undefined });
    try {
      localStorage.setItem(get().cloud ? LAST_KEY + ':cloud' : LAST_KEY, id);
    } catch {
      /* ignore */
    }
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
