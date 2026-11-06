/**
 * Media library storage.
 *
 * `MediaStore` is the seam where a server backend (S3/R2 + API) can be plugged
 * in later. The default implementation keeps uploads in the user's browser
 * (IndexedDB) — nothing leaves the machine, no hosting cost, and copyrighted
 * source material is never redistributed by us.
 */
import { createStore, del, get, keys, set } from 'idb-keyval';
import type { MediaAsset, Project } from '../types';

export interface MediaStore {
  list(): Promise<MediaAsset[]>;
  /** Stores the file; returns the stored asset (a server may assign a new id). */
  put(asset: MediaAsset, blob: Blob): Promise<MediaAsset>;
  getBlob(id: string): Promise<Blob>;
  getMeta(id: string): Promise<MediaAsset | undefined>;
  remove(id: string): Promise<void>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  ownerName?: string;
  role?: 'owner' | 'editor' | 'viewer';
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<Project | undefined>;
  /** Resolves to the stored id (a server may assign a different one). */
  save(p: Project, force?: boolean): Promise<string | void>;
  remove(id: string): Promise<void>;
}

export class IdbMediaStore implements MediaStore {
  private meta = createStore('oto-eum-media-meta', 'meta');
  private blobs = createStore('oto-eum-media-blobs', 'blobs');

  async list(): Promise<MediaAsset[]> {
    const ks = await keys(this.meta);
    const all = await Promise.all(ks.map((k) => get<MediaAsset>(k, this.meta)));
    return all.filter((a): a is MediaAsset => !!a).sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(asset: MediaAsset, blob: Blob) {
    await set(asset.id, blob, this.blobs);
    await set(asset.id, asset, this.meta);
    return asset;
  }
  async getBlob(id: string) {
    const b = await get<Blob>(id, this.blobs);
    if (!b) throw new Error(`Media ${id} not found`);
    return b;
  }
  getMeta(id: string) {
    return get<MediaAsset>(id, this.meta);
  }
  async remove(id: string) {
    await del(id, this.blobs);
    await del(id, this.meta);
  }
}

export class IdbProjectStore implements ProjectStore {
  private s = createStore('oto-eum-projects', 'projects');
  async list() {
    const ks = await keys(this.s);
    const all = await Promise.all(ks.map((k) => get<Project>(k, this.s)));
    return all.filter((p): p is Project => !!p).map((p) => ({ id: p.id, name: p.name }));
  }
  load(id: string) {
    return get<Project>(id, this.s);
  }
  save(p: Project) {
    return set(p.id, p, this.s);
  }
  remove(id: string) {
    return del(id, this.s);
  }
}
