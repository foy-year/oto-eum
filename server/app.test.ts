import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { LocalDiskStorage } from './storage.ts';
import { sniffMedia } from './sniff.ts';

const dir = mkdtempSync(join(tmpdir(), 'oto-eum-test-'));
const config = { ...loadConfig({ DATA_DIR: dir, ADMIN_EMAILS: 'admin@x.io', USER_QUOTA_MB: '1', MAX_UPLOAD_MB: '1' }), corsOrigins: ['http://localhost:5173'] };
const app = createApp({ config, db: openDb(dir), storage: new LocalDiskStorage(dir) });
const mp3 = readFileSync(new URL('../tests/fixtures/melody.mp3', import.meta.url));
const webm = readFileSync(new URL('../tests/fixtures/colors.webm', import.meta.url));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, opts: { token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await app.request(path, { method, headers, body });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, res, data: (ct.includes('json') ? await res.json() : await res.arrayBuffer()) as Json };
}
const register = async (email: string, extra: Json = {}) =>
  (await call('POST', '/api/auth/register', { json: { email, password: 'correct horse', acceptTerms: true, ...extra } })).data;
const upload = (token: string, bytes: Uint8Array, meta: Json = {}, type = 'audio/mpeg') =>
  call('POST', '/api/media', { token, body: bytes, headers: { 'Content-Type': type, 'Content-Length': String(bytes.length), 'X-Oto-Meta': encodeURIComponent(JSON.stringify({ name: 'clip', ...meta })) } });

let alice: string, bob: string, admin: string;
beforeAll(async () => {
  alice = (await register('alice@x.io', { name: 'Alice' })).token;
  bob = (await register('bob@x.io', { name: 'Bob' })).token;
  admin = (await register('admin@x.io')).token;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('auth', () => {
  it('requires terms, strong-enough password, unique email', async () => {
    expect((await call('POST', '/api/auth/register', { json: { email: 'c@x.io', password: 'correct horse' } })).status).toBe(400);
    expect((await call('POST', '/api/auth/register', { json: { email: 'c@x.io', password: 'short', acceptTerms: true } })).status).toBe(400);
    expect((await call('POST', '/api/auth/register', { json: { email: 'alice@x.io', password: 'correct horse', acceptTerms: true } })).status).toBe(409);
  });
  it('logs in, reports usage, logs out', async () => {
    const bad = await call('POST', '/api/auth/login', { json: { email: 'alice@x.io', password: 'nope' } });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/api/auth/login', { json: { email: 'ALICE@x.io', password: 'correct horse' } });
    expect(ok.status).toBe(200);
    const me = await call('GET', '/api/me', { token: ok.data.token });
    expect(me.data).toMatchObject({ email: 'alice@x.io', name: 'Alice', role: 'user', usedBytes: 0 });
    await call('POST', '/api/auth/logout', { token: ok.data.token });
    expect((await call('GET', '/api/me', { token: ok.data.token })).status).toBe(401);
  });
  it('grants admin to configured emails', async () => {
    expect((await call('GET', '/api/me', { token: admin })).data.role).toBe('admin');
  });
  it('sends CORS headers to allowed origins only', async () => {
    const ok = await app.request('/api/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const no = await app.request('/api/health', { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('media', () => {
  let mediaId: string;
  it('validates content by magic bytes', async () => {
    expect(sniffMedia(new Uint8Array(mp3))?.mime).toBe('audio/mpeg');
    expect(sniffMedia(new Uint8Array(webm))?.mime).toBe('video/webm');
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect((await upload(alice, html, {}, 'audio/mpeg')).status).toBe(415);
  });
  it('uploads, lists, streams with Range, dedupes', async () => {
    const r = await upload(alice, mp3, { name: 'melody.mp3', duration: 1.6 });
    expect(r.status).toBe(201);
    mediaId = r.data.id;
    expect(r.data).toMatchObject({ name: 'melody.mp3', kind: 'audio', size: mp3.length, visibility: 'private' });
    expect((await upload(alice, mp3)).data.id).toBe(mediaId); // dedupe
    expect((await call('GET', '/api/media', { token: alice })).data).toHaveLength(1);
    const full = await call('GET', `/api/media/${mediaId}/file`, { token: alice });
    expect(Buffer.from(full.data as ArrayBuffer).equals(mp3)).toBe(true);
    const part = await call('GET', `/api/media/${mediaId}/file`, { token: alice, headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.res.headers.get('content-range')).toBe(`bytes 10-19/${mp3.length}`);
    expect(Buffer.from(part.data as ArrayBuffer).equals(mp3.subarray(10, 20))).toBe(true);
    expect((await call('GET', '/api/me', { token: alice })).data.usedBytes).toBe(mp3.length);
  });
  it('keeps private media private, unlisted readable by link', async () => {
    expect((await call('GET', `/api/media/${mediaId}/file`, { token: bob })).status).toBe(404);
    expect((await call('GET', `/api/media/${mediaId}/file`)).status).toBe(404);
    await call('PATCH', `/api/media/${mediaId}`, { token: alice, json: { visibility: 'unlisted' } });
    expect((await call('GET', `/api/media/${mediaId}/file`)).status).toBe(200);
    await call('PATCH', `/api/media/${mediaId}`, { token: alice, json: { visibility: 'private' } });
    expect((await call('DELETE', `/api/media/${mediaId}`, { token: bob })).data.removedFromLibrary).toBe(true);
    expect((await call('GET', `/api/media/${mediaId}`, { token: alice })).status).toBe(200);
  });
  it('enforces the storage quota', async () => {
    const big = new Uint8Array(1024 * 1024 + 10);
    big.set(mp3.subarray(0, 64));
    expect((await upload(bob, big)).status).toBe(413);
  });
  it('shares private media through a project collaboration', async () => {
    const p = await call('POST', '/api/projects', { token: alice, json: { name: 'collab', data: { samples: [{ sourceId: mediaId }] } } });
    expect((await call('GET', `/api/media/${mediaId}/file`, { token: bob })).status).toBe(404);
    await call('POST', `/api/projects/${p.data.id}/members`, { token: alice, json: { email: 'bob@x.io', role: 'editor' } });
    expect((await call('GET', `/api/media/${mediaId}/file`, { token: bob })).status).toBe(200);
  });
});

describe('projects', () => {
  it('detects conflicting edits and respects roles', async () => {
    const c = await call('POST', '/api/projects', { token: alice, json: { id: 'p-test-1', name: 'Song', data: { bpm: 120 } } });
    expect(c.data).toEqual({ id: 'p-test-1', version: 1 });
    expect((await call('GET', '/api/projects/p-test-1', { token: bob })).status).toBe(404);
    await call('POST', '/api/projects/p-test-1/members', { token: alice, json: { email: 'bob@x.io', role: 'editor' } });
    const v2 = await call('PUT', '/api/projects/p-test-1', { token: bob, json: { data: { bpm: 140 }, baseVersion: 1 } });
    expect(v2.data.version).toBe(2);
    const stale = await call('PUT', '/api/projects/p-test-1', { token: alice, json: { data: { bpm: 100 }, baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.data).toMatchObject({ currentVersion: 2, updatedBy: 'Bob' });
    const got = await call('GET', '/api/projects/p-test-1', { token: alice });
    expect(got.data.data.bpm).toBe(140);
    expect((await call('GET', '/api/projects', { token: bob })).data.map((p: Json) => p.id)).toContain('p-test-1');
    await call('POST', '/api/projects/p-test-1/members', { token: alice, json: { email: 'bob@x.io', role: 'viewer' } });
    expect((await call('PUT', '/api/projects/p-test-1', { token: bob, json: { data: {}, baseVersion: 2 } })).status).toBe(403);
    expect((await call('DELETE', '/api/projects/p-test-1', { token: bob })).status).toBe(404);
  });
});

describe('packs, reports and takedowns', () => {
  let packId: string, vid: string;
  it('publishes a pack whose items become reachable and savable', async () => {
    vid = (await upload(alice, webm, { name: 'colors.webm', kind: 'video' }, 'video/webm')).data.id;
    const p = await call('POST', '/api/packs', { token: alice, json: { name: 'Colour pack', description: 'test', visibility: 'private' } });
    packId = p.data.id;
    await call('POST', `/api/packs/${packId}/items`, { token: alice, json: { mediaId: vid } });
    expect((await call('GET', `/api/packs/${packId}`, { token: bob })).status).toBe(404);
    await call('PATCH', `/api/packs/${packId}`, { token: alice, json: { visibility: 'public' } });
    const list = await call('GET', '/api/packs?q=Colour');
    expect(list.data.map((x: Json) => x.id)).toContain(packId);
    const pack = await call('GET', `/api/packs/${packId}`);
    expect(pack.data.items[0]).toMatchObject({ id: vid, kind: 'video', ownerName: 'Alice', visibility: 'unlisted' });
    await call('POST', `/api/library/${vid}`, { token: bob });
    const lib = (await call('GET', '/api/media', { token: bob })).data;
    expect(lib.find((m: Json) => m.id === vid)).toMatchObject({ ownerName: 'Alice' });
    expect((await call('POST', `/api/packs/${packId}/items`, { token: bob, json: { mediaId: vid } })).status).toBe(404);
  });
  it('lets anyone report, and admins take down and restore', async () => {
    expect((await call('POST', '/api/reports', { json: { targetType: 'media', targetId: vid, reason: 'copyright', details: 'This is my film.' } })).status).toBe(400); // no contact
    const r = await call('POST', '/api/reports', { json: { targetType: 'media', targetId: vid, reason: 'copyright', details: 'This is my copyrighted film.', contactEmail: 'studio@film.io' } });
    expect(r.status).toBe(201);
    expect((await call('GET', '/api/admin/reports', { token: alice })).status).toBe(403);
    const open = await call('GET', '/api/admin/reports', { token: admin });
    expect(open.data.map((x: Json) => x.id)).toContain(r.data.id);
    await call('POST', `/api/admin/reports/${r.data.id}/resolve`, { token: admin, json: { action: 'remove', note: 'valid notice' } });
    expect((await call('GET', `/api/media/${vid}/file`, { token: bob })).status).toBe(451);
    expect((await call('GET', `/api/media/${vid}/file`, { token: alice })).status).toBe(451);
    expect((await call('GET', `/api/packs/${packId}`)).data.items).toHaveLength(0);
    const r2 = await call('POST', '/api/reports', { token: alice, json: { targetType: 'media', targetId: vid, reason: 'other', details: 'Counter-notice: licensed.' } });
    await call('POST', `/api/admin/reports/${r2.data.id}/resolve`, { token: admin, json: { action: 'restore' } });
    expect((await call('GET', `/api/media/${vid}/file`, { token: bob })).status).toBe(200);
    const log = await call('GET', '/api/admin/audit', { token: admin });
    expect(log.data.map((x: Json) => x.action)).toEqual(expect.arrayContaining(['report.remove', 'report.restore', 'media.upload']));
  });
  it('suspends users', async () => {
    const me = (await call('GET', '/api/me', { token: bob })).data;
    await call('POST', `/api/admin/users/${me.id}/ban`, { token: admin, json: { banned: true } });
    expect((await call('GET', '/api/me', { token: bob })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { json: { email: 'bob@x.io', password: 'correct horse' } })).status).toBe(403);
  });
});
