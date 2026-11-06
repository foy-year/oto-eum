/**
 * Cloud storage: talks to the oto-eum server (see /server). Implements the
 * same MediaStore / ProjectStore interfaces as the local IndexedDB stores, so
 * the rest of the app does not care where files live.
 */
import { createStore, get, set, del } from 'idb-keyval';
import type { MediaAsset, Project } from '../types';
import type { MediaStore, ProjectStore, ProjectSummary } from './mediaStore';

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export class ConflictError extends ApiError {}

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  quotaBytes: number;
  usedBytes: number;
}

export type Visibility = 'private' | 'unlisted' | 'public';

export interface Pack {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  ownerId: string;
  ownerName?: string;
  itemCount: number;
  items?: MediaAsset[];
}

export interface Report {
  id: string;
  target_type: 'media' | 'pack';
  target_id: string;
  reason: string;
  details: string;
  contact_email?: string;
  status: string;
  created_at: number;
}

export class ApiClient {
  base: string;
  token: string | null;
  constructor(base: string, token: string | null = null) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }

  async request<T = unknown>(method: string, path: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; raw?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await fetch(this.base + path, { method, headers, body });
    } catch {
      throw new ApiError(0, `Cannot reach the server at ${this.base}`);
    }
    if (opts.raw && res.ok) return res as T;
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : {};
    if (!res.ok) {
      const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
      throw res.status === 409 ? new ConflictError(409, msg, data) : new ApiError(res.status, msg, data);
    }
    return data as T;
  }

  health() {
    return this.request<{ ok: boolean; signup: boolean; maxUploadBytes: number }>('GET', '/api/health');
  }
  policy() {
    return this.request<{ text: string }>('GET', '/api/policy');
  }
  async register(email: string, password: string, name: string, acceptTerms: boolean) {
    const r = await this.request<{ token: string; user: CloudUser }>('POST', '/api/auth/register', { json: { email, password, name, acceptTerms } });
    this.token = r.token;
    return r;
  }
  async login(email: string, password: string) {
    const r = await this.request<{ token: string; user: CloudUser }>('POST', '/api/auth/login', { json: { email, password } });
    this.token = r.token;
    return r;
  }
  async logout() {
    await this.request('POST', '/api/auth/logout').catch(() => {});
    this.token = null;
  }
  me() {
    return this.request<CloudUser>('GET', '/api/me');
  }

  uploadMedia(blob: Blob, meta: Partial<MediaAsset>) {
    return this.request<MediaAsset>('POST', '/api/media', {
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Oto-Meta': encodeURIComponent(JSON.stringify(meta)) },
    });
  }
  listMedia(scope: 'library' | 'mine' = 'library') {
    return this.request<MediaAsset[]>('GET', `/api/media?scope=${scope}`);
  }
  mediaMeta(id: string) {
    return this.request<MediaAsset>('GET', `/api/media/${encodeURIComponent(id)}`);
  }
  async mediaFile(id: string): Promise<Blob> {
    const res = await this.request<Response>('GET', `/api/media/${encodeURIComponent(id)}/file`, { raw: true });
    return res.blob();
  }
  updateMedia(id: string, patch: { name?: string; visibility?: Visibility }) {
    return this.request<MediaAsset>('PATCH', `/api/media/${encodeURIComponent(id)}`, { json: patch });
  }
  deleteMedia(id: string) {
    return this.request('DELETE', `/api/media/${encodeURIComponent(id)}`);
  }
  saveToLibrary(id: string) {
    return this.request<MediaAsset>('POST', `/api/library/${encodeURIComponent(id)}`);
  }

  listProjects() {
    return this.request<ProjectSummary[]>('GET', '/api/projects');
  }
  getProject(id: string) {
    return this.request<{ id: string; name: string; version: number; role: 'owner' | 'editor' | 'viewer'; data: Project }>('GET', `/api/projects/${encodeURIComponent(id)}`);
  }
  createProject(p: Project) {
    return this.request<{ id: string; version: number }>('POST', '/api/projects', { json: { id: p.id, name: p.name, data: p } });
  }
  updateProject(p: Project, baseVersion: number, force = false) {
    return this.request<{ id: string; version: number }>('PUT', `/api/projects/${encodeURIComponent(p.id)}`, { json: { name: p.name, data: p, baseVersion, force } });
  }
  deleteProject(id: string) {
    return this.request('DELETE', `/api/projects/${encodeURIComponent(id)}`);
  }
  members(id: string) {
    return this.request<Array<{ id: string; name: string; email: string; role: string }>>('GET', `/api/projects/${encodeURIComponent(id)}/members`);
  }
  share(id: string, email: string, role: 'editor' | 'viewer') {
    return this.request('POST', `/api/projects/${encodeURIComponent(id)}/members`, { json: { email, role } });
  }
  unshare(id: string, userId: string) {
    return this.request('DELETE', `/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`);
  }

  listPacks(scope: 'public' | 'mine', q = '') {
    return this.request<Pack[]>('GET', `/api/packs?scope=${scope}&q=${encodeURIComponent(q)}`);
  }
  getPack(id: string) {
    return this.request<Pack>('GET', `/api/packs/${encodeURIComponent(id)}`);
  }
  createPack(name: string, description: string, visibility: Visibility) {
    return this.request<Pack>('POST', '/api/packs', { json: { name, description, visibility } });
  }
  updatePack(id: string, patch: Partial<Pick<Pack, 'name' | 'description' | 'visibility'>>) {
    return this.request<Pack>('PATCH', `/api/packs/${encodeURIComponent(id)}`, { json: patch });
  }
  deletePack(id: string) {
    return this.request('DELETE', `/api/packs/${encodeURIComponent(id)}`);
  }
  addToPack(id: string, mediaId: string) {
    return this.request<Pack>('POST', `/api/packs/${encodeURIComponent(id)}/items`, { json: { mediaId } });
  }
  removeFromPack(id: string, mediaId: string) {
    return this.request<Pack>('DELETE', `/api/packs/${encodeURIComponent(id)}/items/${encodeURIComponent(mediaId)}`);
  }

  report(targetType: 'media' | 'pack', targetId: string, reason: 'copyright' | 'abuse' | 'other', details: string, contactEmail?: string) {
    return this.request<{ id: string }>('POST', '/api/reports', { json: { targetType, targetId, reason, details, contactEmail } });
  }
  adminReports(status = 'open') {
    return this.request<Report[]>('GET', `/api/admin/reports?status=${status}`);
  }
  resolveReport(id: string, action: 'remove' | 'restore' | 'dismiss', note = '') {
    return this.request('POST', `/api/admin/reports/${encodeURIComponent(id)}/resolve`, { json: { action, note } });
  }
}

/** Server-backed media with a local IndexedDB cache of downloaded files. */
export class RemoteMediaStore implements MediaStore {
  api: ApiClient;
  private cache = createStore('oto-eum-cloud-cache', 'blobs');
  constructor(api: ApiClient) {
    this.api = api;
  }
  list() {
    return this.api.listMedia('library');
  }
  async put(asset: MediaAsset, blob: Blob) {
    const stored = await this.api.uploadMedia(blob, { name: asset.name, kind: asset.kind, duration: asset.duration, width: asset.width, height: asset.height, fps: asset.fps });
    await set(stored.id, blob, this.cache).catch(() => {});
    return stored;
  }
  async getBlob(id: string) {
    const cached = await get<Blob>(id, this.cache).catch(() => undefined);
    if (cached) return cached;
    const blob = await this.api.mediaFile(id);
    if (blob.size < 300 * 1024 * 1024) await set(id, blob, this.cache).catch(() => {});
    return blob;
  }
  getMeta(id: string) {
    return this.api.mediaMeta(id).catch(() => undefined);
  }
  async remove(id: string) {
    await this.api.deleteMedia(id);
    await del(id, this.cache).catch(() => {});
  }
}

/** Server-backed projects with optimistic concurrency. */
export class RemoteProjectStore implements ProjectStore {
  api: ApiClient;
  /** Last known server version per project id. */
  versions = new Map<string, number>();
  roles = new Map<string, 'owner' | 'editor' | 'viewer'>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(api: ApiClient) {
    this.api = api;
  }
  list() {
    return this.api.listProjects();
  }
  async load(id: string) {
    const r = await this.api.getProject(id);
    this.versions.set(r.id, r.version);
    this.roles.set(r.id, r.role);
    return { ...r.data, id: r.id, name: r.name };
  }
  /**
   * Saves are serialised so our own rapid autosaves never conflict with each
   * other. Resolves to the server-side id (a new id if ours was taken).
   * Throws ConflictError when someone else saved in between (or the project
   * exists on the server but was never loaded here) — unless `force`.
   */
  save(p: Project, force = false): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.roles.get(p.id) === 'viewer') return p.id;
      let v = this.versions.get(p.id);
      if (v == null) {
        const existing = await this.api.getProject(p.id).catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        });
        if (!existing) {
          const r = await this.api.createProject(p);
          this.versions.set(r.id, r.version);
          this.roles.set(r.id, 'owner');
          return r.id;
        }
        this.roles.set(p.id, existing.role);
        if (!force) throw new ConflictError(409, 'This project also exists on the server with different content', { currentVersion: existing.version });
        v = existing.version;
      }
      const r = await this.api.updateProject(p, v, force);
      this.versions.set(p.id, r.version);
      return p.id;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
  async remove(id: string) {
    await this.api.deleteProject(id);
    this.versions.delete(id);
  }
}
