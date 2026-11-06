/**
 * oto-eum API server.
 *
 *  - accounts (email + password, bearer session tokens)
 *  - media uploads with quotas, magic-byte validation, dedupe, Range streaming
 *  - projects with optimistic concurrency (version numbers) and collaborators
 *  - source packs (shareable collections of media) + "save to my library"
 *  - copyright / abuse reports and an admin takedown workflow (audited)
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Config } from './config.ts';
import { type DB, audit } from './db.ts';
import { type BlobStorage, TooLargeError } from './storage.ts';
import { sniffMedia } from './sniff.ts';
import { RateLimiter, createSession, destroySession, hashPassword, newId, userForToken, verifyPassword, type SessionUser } from './auth.ts';
import { policyText } from './policy.ts';

type Vars = { user: SessionUser | null; token: string | null };
type C = Context<{ Variables: Vars }>;

const VIS = ['private', 'unlisted', 'public'] as const;
type Visibility = (typeof VIS)[number];

interface MediaRow {
  id: string;
  owner_id: string;
  name: string;
  kind: 'audio' | 'video';
  mime: string;
  size: number;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  sha256: string;
  visibility: Visibility;
  status: 'active' | 'removed';
  removed_reason: string | null;
  created_at: number;
}

const fail = (status: number, message: string): never => {
  throw new HTTPException(status as 400, { message });
};

function mediaJson(m: MediaRow, owner?: { name: string }) {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    mime: m.mime,
    size: m.size,
    duration: m.duration,
    width: m.width ?? undefined,
    height: m.height ?? undefined,
    fps: m.fps ?? undefined,
    createdAt: m.created_at,
    visibility: m.visibility,
    status: m.status,
    ownerId: m.owner_id,
    ownerName: owner?.name,
  };
}

export interface AppDeps {
  config: Config;
  db: DB;
  storage: BlobStorage;
}

export function createApp({ config, db, storage }: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const authLimiter = new RateLimiter(20, 60_000);
  const uploadLimiter = new RateLimiter(60, 60_000);
  const reportLimiter = new RateLimiter(10, 60_000);
  const ip = (c: C) => c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? 'local';

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'X-Oto-Meta', 'Range'],
      exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  // session
  app.use('/api/*', async (c, next) => {
    const h = c.req.header('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    c.set('token', token);
    c.set('user', token ? userForToken(db, token) : null);
    await next();
  });

  const requireUser = (c: C): SessionUser => c.get('user') ?? fail(401, 'Sign in required');
  const requireAdmin = (c: C): SessionUser => {
    const u = requireUser(c);
    return u.role === 'admin' ? u : fail(403, 'Admins only');
  };
  const json = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof TooLargeError) return c.json({ error: err.message }, 413);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // -------------------------------------------------------------------------
  // meta
  // -------------------------------------------------------------------------
  app.get('/api/health', (c) =>
    c.json({ ok: true, service: 'oto-eum', signup: config.allowSignup, maxUploadBytes: config.maxUploadBytes }),
  );
  app.get('/api/policy', (c) => c.json({ text: policyText(config) }));

  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  const usage = (userId: string) =>
    (db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM media WHERE owner_id = ? AND status = 'active'").get(userId) as { used: number }).used;
  const meJson = (u: SessionUser) => ({ id: u.id, email: u.email, name: u.name, role: u.role, quotaBytes: u.quota_bytes, usedBytes: usage(u.id) });

  app.post('/api/auth/register', json, async (c) => {
    if (!authLimiter.allow(ip(c))) fail(429, 'Too many attempts, try again in a minute');
    if (!config.allowSignup) fail(403, 'Sign-up is disabled on this server');
    const b = await c.req.json<{ email?: string; password?: string; name?: string; acceptTerms?: boolean }>();
    const email = (b.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail(400, 'Invalid email');
    if ((b.password ?? '').length < 8) fail(400, 'Password must be at least 8 characters');
    if (!b.acceptTerms) fail(400, 'You must accept the content & copyright policy');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'An account with this email already exists');
    const id = newId('u_');
    const name = (b.name ?? '').trim().slice(0, 60) || email.split('@')[0];
    const role = config.adminEmails.includes(email) ? 'admin' : 'user';
    const now = Date.now();
    db.prepare('INSERT INTO users (id, email, name, pass_hash, role, quota_bytes, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      email,
      name,
      await hashPassword(b.password!),
      role,
      config.defaultQuotaBytes,
      now,
      now,
    );
    audit(db, id, 'user.register', id);
    const token = createSession(db, id, config.sessionDays);
    return c.json({ token, user: meJson(userForToken(db, token)!) }, 201);
  });

  app.post('/api/auth/login', json, async (c) => {
    if (!authLimiter.allow(ip(c))) fail(429, 'Too many attempts, try again in a minute');
    const b = await c.req.json<{ email?: string; password?: string }>();
    const row = db.prepare('SELECT id, pass_hash, banned FROM users WHERE email = ?').get((b.email ?? '').trim().toLowerCase()) as
      | { id: string; pass_hash: string; banned: number }
      | undefined;
    if (!row || !(await verifyPassword(b.password ?? '', row.pass_hash))) fail(401, 'Wrong email or password');
    if (row!.banned) fail(403, 'This account has been suspended');
    const token = createSession(db, row!.id, config.sessionDays);
    return c.json({ token, user: meJson(userForToken(db, token)!) });
  });

  app.post('/api/auth/logout', (c) => {
    const t = c.get('token');
    if (t) destroySession(db, t);
    return c.json({ ok: true });
  });

  app.get('/api/me', (c) => c.json(meJson(requireUser(c))));

  // -------------------------------------------------------------------------
  // media
  // -------------------------------------------------------------------------
  const getMedia = (id: string) => db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;

  /** Can `user` read media `m`? (Removed media is handled by the caller.) */
  function canRead(user: SessionUser | null, m: MediaRow): boolean {
    if (user && (user.id === m.owner_id || user.role === 'admin')) return true;
    if (m.visibility !== 'private') return true;
    if (!user) return false;
    // shared through a project the user collaborates on, owned/edited by the media owner
    const viaProject = db
      .prepare(
        `SELECT 1 FROM projects p
         WHERE p.data LIKE ? AND (p.owner_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))
           AND (p.owner_id = ? OR EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = p.id AND pm2.user_id = ?))
         LIMIT 1`,
      )
      .get(`%"${m.id}"%`, user.id, user.id, m.owner_id, m.owner_id);
    return !!viaProject;
  }

  app.post('/api/media', async (c) => {
    const user = requireUser(c);
    if (!uploadLimiter.allow(user.id)) fail(429, 'Too many uploads, slow down');
    let meta: { name?: string; kind?: string; duration?: number; width?: number; height?: number; fps?: number; visibility?: string } = {};
    try {
      meta = JSON.parse(decodeURIComponent(c.req.header('x-oto-meta') ?? '{}'));
    } catch {
      fail(400, 'Bad X-Oto-Meta header');
    }
    const declared = Number(c.req.header('content-length') ?? 0);
    const remaining = user.quota_bytes - usage(user.id);
    if (declared > config.maxUploadBytes) fail(413, `File exceeds ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    if (declared > remaining) fail(413, 'Storage quota exceeded');
    const body = c.req.raw.body ?? fail(400, 'Empty body');
    const id = newId('m_');
    const stored = await storage.put(id, body as ReadableStream<Uint8Array>, Math.min(config.maxUploadBytes, remaining));
    const sniffed = sniffMedia(stored.head);
    if (!sniffed) {
      await storage.delete(id);
      fail(415, 'Only audio and video files are accepted');
    }
    if (stored.size === 0) {
      await storage.delete(id);
      fail(400, 'Empty file');
    }
    // identical file already uploaded by this user → reuse it
    const dup = db.prepare("SELECT * FROM media WHERE owner_id = ? AND sha256 = ? AND status = 'active'").get(user.id, stored.sha256) as MediaRow | undefined;
    if (dup) {
      await storage.delete(id);
      return c.json(mediaJson(dup), 200);
    }
    const kind = sniffed!.kind === 'either' ? (meta.kind === 'audio' ? 'audio' : 'video') : sniffed!.kind;
    const mime = (c.req.header('content-type') ?? '').match(/^(audio|video)\/[\w.+-]+$/) ? c.req.header('content-type')! : sniffed!.mime;
    const vis: Visibility = VIS.includes(meta.visibility as Visibility) ? (meta.visibility as Visibility) : 'private';
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    db.prepare(
      `INSERT INTO media (id, owner_id, name, kind, mime, size, duration, width, height, fps, sha256, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, String(meta.name ?? 'upload').slice(0, 200), kind, mime, stored.size, n(meta.duration) ?? 0, n(meta.width), n(meta.height), n(meta.fps), stored.sha256, vis, Date.now());
    audit(db, user.id, 'media.upload', id, { size: stored.size, sha256: stored.sha256 });
    return c.json(mediaJson(getMedia(id)!), 201);
  });

  /** mine = uploads; library = uploads + items saved from packs. */
  app.get('/api/media', (c) => {
    const user = requireUser(c);
    const scope = c.req.query('scope') ?? 'library';
    const rows =
      scope === 'mine'
        ? (db.prepare('SELECT * FROM media WHERE owner_id = ? ORDER BY created_at').all(user.id) as unknown as MediaRow[])
        : (db
            .prepare(
              `SELECT m.* FROM media m WHERE m.owner_id = ?
               UNION SELECT m.* FROM media m JOIN library_items l ON l.media_id = m.id WHERE l.user_id = ? AND m.status = 'active'
               ORDER BY created_at`,
            )
            .all(user.id, user.id) as unknown as MediaRow[]);
    const names = new Map<string, string>();
    const ownerName = (id: string) => {
      if (!names.has(id)) names.set(id, (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '');
      return { name: names.get(id)! };
    };
    return c.json(rows.map((m) => mediaJson(m, ownerName(m.owner_id))));
  });

  app.get('/api/media/:id', (c) => {
    const m = getMedia(c.req.param('id'));
    const user = c.get('user');
    if (!m || !canRead(user, m)) fail(404, 'Not found');
    return c.json(mediaJson(m!));
  });

  app.get('/api/media/:id/file', async (c) => {
    const m = getMedia(c.req.param('id'));
    const user = c.get('user');
    if (!m || !canRead(user, m)) fail(404, 'Not found');
    if (m!.status === 'removed' && user?.role !== 'admin') fail(451, `Removed: ${m!.removed_reason ?? 'policy violation'}`);
    const size = m!.size;
    const headers: Record<string, string> = {
      'Content-Type': m!.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': m!.visibility === 'private' ? 'private, max-age=3600' : 'public, max-age=86400',
      ETag: `"${m!.sha256}"`,
    };
    const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? +range[1] : size - +range[2];
      let end = range[1] && range[2] ? +range[2] : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
      return c.body(storage.get(m!.id, { start, end }), 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    }
    return c.body(storage.get(m!.id), 200, { ...headers, 'Content-Length': String(size) });
  });

  app.patch('/api/media/:id', json, async (c) => {
    const user = requireUser(c);
    const m = getMedia(c.req.param('id'));
    if (!m || m.owner_id !== user.id) fail(404, 'Not found');
    const b = await c.req.json<{ name?: string; visibility?: Visibility }>();
    if (b.visibility && !VIS.includes(b.visibility)) fail(400, 'Bad visibility');
    db.prepare('UPDATE media SET name = COALESCE(?, name), visibility = COALESCE(?, visibility) WHERE id = ?').run(b.name?.slice(0, 200) ?? null, b.visibility ?? null, m!.id);
    return c.json(mediaJson(getMedia(m!.id)!));
  });

  app.delete('/api/media/:id', async (c) => {
    const user = requireUser(c);
    const m = getMedia(c.req.param('id'));
    if (!m) fail(404, 'Not found');
    if (m!.owner_id !== user.id) {
      // not the owner: just remove it from my library
      db.prepare('DELETE FROM library_items WHERE user_id = ? AND media_id = ?').run(user.id, m!.id);
      return c.json({ ok: true, removedFromLibrary: true });
    }
    db.prepare('DELETE FROM media WHERE id = ?').run(m!.id);
    await storage.delete(m!.id);
    audit(db, user.id, 'media.delete', m!.id);
    return c.json({ ok: true });
  });

  app.post('/api/library/:mediaId', (c) => {
    const user = requireUser(c);
    const m = getMedia(c.req.param('mediaId'));
    if (!m || m.status !== 'active' || !canRead(user, m)) fail(404, 'Not found');
    db.prepare('INSERT OR IGNORE INTO library_items (user_id, media_id, added_at) VALUES (?, ?, ?)').run(user.id, m!.id, Date.now());
    return c.json(mediaJson(m!));
  });

  // -------------------------------------------------------------------------
  // projects
  // -------------------------------------------------------------------------
  type ProjectRow = { id: string; owner_id: string; name: string; data: string; version: number; updated_by: string | null; created_at: number; updated_at: number };
  const roleIn = (user: SessionUser, p: ProjectRow): 'owner' | 'editor' | 'viewer' | null => {
    if (p.owner_id === user.id) return 'owner';
    const r = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(p.id, user.id) as { role: 'editor' | 'viewer' } | undefined;
    return r?.role ?? (user.role === 'admin' ? 'viewer' : null);
  };
  const getProject = (id: string) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;

  app.get('/api/projects', (c) => {
    const user = requireUser(c);
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.version, p.updated_at, p.owner_id, u.name AS owner_name,
                CASE WHEN p.owner_id = ? THEN 'owner' ELSE pm.role END AS role
         FROM projects p JOIN users u ON u.id = p.owner_id
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE p.owner_id = ? OR pm.user_id = ? ORDER BY p.updated_at DESC`,
      )
      .all(user.id, user.id, user.id, user.id) as Array<Record<string, unknown>>;
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, version: r.version, updatedAt: r.updated_at, ownerName: r.owner_name, role: r.role })));
  });

  app.post('/api/projects', json, async (c) => {
    const user = requireUser(c);
    const b = await c.req.json<{ id?: string; name?: string; data?: unknown }>();
    if (!b.data || typeof b.data !== 'object') fail(400, 'Missing project data');
    let id = typeof b.id === 'string' && /^[\w-]{4,64}$/.test(b.id) ? b.id : newId('p_');
    if (getProject(id)) id = newId('p_');
    const now = Date.now();
    const data = { ...(b.data as object), id };
    db.prepare('INSERT INTO projects (id, owner_id, name, data, version, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(
      id,
      user.id,
      String(b.name ?? 'Untitled').slice(0, 200),
      JSON.stringify(data),
      user.id,
      now,
      now,
    );
    return c.json({ id, version: 1 }, 201);
  });

  app.get('/api/projects/:id', (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    const role = p && roleIn(user, p);
    if (!p || !role) fail(404, 'Not found');
    return c.json({ id: p!.id, name: p!.name, version: p!.version, role, updatedAt: p!.updated_at, data: JSON.parse(p!.data) });
  });

  app.put('/api/projects/:id', json, async (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    const role = p && roleIn(user, p);
    if (!p || !role) fail(404, 'Not found');
    if (role === 'viewer') fail(403, 'You have view-only access to this project');
    const b = await c.req.json<{ name?: string; data?: unknown; baseVersion?: number; force?: boolean }>();
    if (!b.data || typeof b.data !== 'object') fail(400, 'Missing project data');
    if (!b.force && b.baseVersion !== p!.version) {
      const who = db.prepare('SELECT name FROM users WHERE id = ?').get(p!.updated_by ?? '') as { name: string } | undefined;
      return c.json({ error: 'Project was changed by someone else', currentVersion: p!.version, updatedBy: who?.name, updatedAt: p!.updated_at }, 409);
    }
    const version = p!.version + 1;
    db.prepare('UPDATE projects SET name = ?, data = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
      String(b.name ?? p!.name).slice(0, 200),
      JSON.stringify({ ...(b.data as object), id: p!.id }),
      version,
      user.id,
      Date.now(),
      p!.id,
    );
    return c.json({ id: p!.id, version });
  });

  app.delete('/api/projects/:id', (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Not found');
    db.prepare('DELETE FROM projects WHERE id = ?').run(p!.id);
    return c.json({ ok: true });
  });

  app.get('/api/projects/:id/members', (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    if (!p || !roleIn(user, p)) fail(404, 'Not found');
    const rows = db.prepare('SELECT u.id, u.name, u.email, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ?').all(p!.id);
    return c.json(rows);
  });

  app.post('/api/projects/:id/members', json, async (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Only the project owner can share it');
    const b = await c.req.json<{ email?: string; role?: string }>();
    const role = b.role === 'viewer' ? 'viewer' : 'editor';
    const target = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get((b.email ?? '').trim().toLowerCase()) as { id: string; name: string; email: string } | undefined;
    if (!target) fail(404, 'No user with that email — they need to create an account first');
    if (target!.id === user.id) fail(400, 'You already own this project');
    db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role').run(p!.id, target!.id, role);
    audit(db, user.id, 'project.share', p!.id, { with: target!.id, role });
    return c.json({ ...target, role });
  });

  app.delete('/api/projects/:id/members/:userId', (c) => {
    const user = requireUser(c);
    const p = getProject(c.req.param('id'));
    const target = c.req.param('userId');
    if (!p || (p.owner_id !== user.id && target !== user.id)) fail(404, 'Not found');
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(p!.id, target);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // source packs
  // -------------------------------------------------------------------------
  type PackRow = { id: string; owner_id: string; name: string; description: string; visibility: Visibility; status: string; created_at: number };
  const getPack = (id: string) => db.prepare('SELECT * FROM packs WHERE id = ?').get(id) as PackRow | undefined;
  const packJson = (p: PackRow, withItems: boolean) => {
    const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(p.owner_id) as { name: string };
    const count = (db.prepare('SELECT COUNT(*) AS n FROM pack_items WHERE pack_id = ?').get(p.id) as { n: number }).n;
    const base = { id: p.id, name: p.name, description: p.description, visibility: p.visibility, status: p.status, ownerId: p.owner_id, ownerName: owner?.name, itemCount: count, createdAt: p.created_at };
    if (!withItems) return base;
    const items = db
      .prepare("SELECT m.* FROM pack_items pi JOIN media m ON m.id = pi.media_id WHERE pi.pack_id = ? AND m.status = 'active' ORDER BY pi.position")
      .all(p.id) as unknown as MediaRow[];
    return { ...base, items: items.map((m) => mediaJson(m, owner)) };
  };

  app.get('/api/packs', (c) => {
    const scope = c.req.query('scope') ?? 'public';
    const q = `%${(c.req.query('q') ?? '').slice(0, 100)}%`;
    if (scope === 'mine') {
      const u = requireUser(c);
      const rows = db.prepare('SELECT * FROM packs WHERE owner_id = ? ORDER BY created_at DESC').all(u.id) as unknown as PackRow[];
      return c.json(rows.map((p) => packJson(p, false)));
    }
    const rows = db
      .prepare("SELECT * FROM packs WHERE visibility = 'public' AND status = 'active' AND (name LIKE ? OR description LIKE ?) ORDER BY created_at DESC LIMIT 100")
      .all(q, q) as unknown as PackRow[];
    return c.json(rows.map((p) => packJson(p, false)));
  });

  app.post('/api/packs', json, async (c) => {
    const user = requireUser(c);
    const b = await c.req.json<{ name?: string; description?: string; visibility?: Visibility }>();
    if (!b.name?.trim()) fail(400, 'Pack needs a name');
    const id = newId('k_');
    db.prepare('INSERT INTO packs (id, owner_id, name, description, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      user.id,
      b.name!.trim().slice(0, 120),
      (b.description ?? '').slice(0, 2000),
      VIS.includes(b.visibility as Visibility) ? b.visibility! : 'unlisted',
      Date.now(),
    );
    return c.json(packJson(getPack(id)!, true), 201);
  });

  app.get('/api/packs/:id', (c) => {
    const user = c.get('user');
    const p = getPack(c.req.param('id'));
    if (!p) fail(404, 'Not found');
    const mine = user && (user.id === p!.owner_id || user.role === 'admin');
    if (!mine && (p!.visibility === 'private' || p!.status !== 'active')) fail(p!.status !== 'active' ? 451 : 404, p!.status !== 'active' ? 'This pack was removed' : 'Not found');
    return c.json(packJson(p!, true));
  });

  app.patch('/api/packs/:id', json, async (c) => {
    const user = requireUser(c);
    const p = getPack(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Not found');
    const b = await c.req.json<{ name?: string; description?: string; visibility?: Visibility }>();
    if (b.visibility && !VIS.includes(b.visibility)) fail(400, 'Bad visibility');
    db.prepare('UPDATE packs SET name = COALESCE(?, name), description = COALESCE(?, description), visibility = COALESCE(?, visibility) WHERE id = ?').run(
      b.name?.slice(0, 120) ?? null,
      b.description?.slice(0, 2000) ?? null,
      b.visibility ?? null,
      p!.id,
    );
    if (b.visibility && b.visibility !== 'private') {
      // items of a shared pack must be reachable by its viewers
      db.prepare("UPDATE media SET visibility = 'unlisted' WHERE visibility = 'private' AND id IN (SELECT media_id FROM pack_items WHERE pack_id = ?)").run(p!.id);
    }
    return c.json(packJson(getPack(p!.id)!, true));
  });

  app.delete('/api/packs/:id', (c) => {
    const user = requireUser(c);
    const p = getPack(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Not found');
    db.prepare('DELETE FROM packs WHERE id = ?').run(p!.id);
    return c.json({ ok: true });
  });

  app.post('/api/packs/:id/items', json, async (c) => {
    const user = requireUser(c);
    const p = getPack(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Not found');
    const { mediaId } = await c.req.json<{ mediaId?: string }>();
    const m = getMedia(mediaId ?? '');
    if (!m || m.owner_id !== user.id) fail(400, 'You can only add your own uploads to a pack');
    if (p!.visibility !== 'private' && m!.visibility === 'private') db.prepare("UPDATE media SET visibility = 'unlisted' WHERE id = ?").run(m!.id);
    const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM pack_items WHERE pack_id = ?').get(p!.id) as { n: number }).n;
    db.prepare('INSERT OR IGNORE INTO pack_items (pack_id, media_id, position) VALUES (?, ?, ?)').run(p!.id, m!.id, pos);
    return c.json(packJson(getPack(p!.id)!, true));
  });

  app.delete('/api/packs/:id/items/:mediaId', (c) => {
    const user = requireUser(c);
    const p = getPack(c.req.param('id'));
    if (!p || p.owner_id !== user.id) fail(404, 'Not found');
    db.prepare('DELETE FROM pack_items WHERE pack_id = ? AND media_id = ?').run(p!.id, c.req.param('mediaId'));
    return c.json(packJson(getPack(p!.id)!, true));
  });

  // -------------------------------------------------------------------------
  // reports & moderation
  // -------------------------------------------------------------------------
  app.post('/api/reports', json, async (c) => {
    if (!reportLimiter.allow(ip(c))) fail(429, 'Too many reports, try again later');
    const user = c.get('user');
    const b = await c.req.json<{ targetType?: string; targetId?: string; reason?: string; details?: string; contactEmail?: string }>();
    if (!['media', 'pack'].includes(b.targetType ?? '')) fail(400, 'targetType must be media or pack');
    if (!['copyright', 'abuse', 'other'].includes(b.reason ?? '')) fail(400, 'reason must be copyright, abuse or other');
    const exists = b.targetType === 'media' ? getMedia(b.targetId ?? '') : getPack(b.targetId ?? '');
    if (!exists) fail(404, 'Reported item not found');
    if ((b.details ?? '').trim().length < 10) fail(400, 'Please describe the problem (min. 10 characters)');
    if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.contactEmail ?? '')) fail(400, 'A contact email is required');
    const id = newId('r_');
    db.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      user?.id ?? null,
      b.targetType!,
      b.targetId!,
      b.reason!,
      b.details!.slice(0, 5000),
      (b.contactEmail ?? user?.email ?? null)?.slice(0, 200) ?? null,
      Date.now(),
    );
    audit(db, user?.id ?? null, 'report.create', id, { target: `${b.targetType}:${b.targetId}`, reason: b.reason });
    return c.json({ id, status: 'open' }, 201);
  });

  app.get('/api/admin/reports', (c) => {
    requireAdmin(c);
    const status = c.req.query('status') ?? 'open';
    return c.json(db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at').all(status));
  });

  /** action: remove (takedown), restore (e.g. after a counter-notice), dismiss. */
  app.post('/api/admin/reports/:id/resolve', json, async (c) => {
    const admin = requireAdmin(c);
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(c.req.param('id')) as { id: string; target_type: string; target_id: string; reason: string } | undefined;
    if (!r) fail(404, 'Not found');
    const b = await c.req.json<{ action?: string; note?: string }>();
    if (!['remove', 'restore', 'dismiss'].includes(b.action ?? '')) fail(400, 'action must be remove, restore or dismiss');
    const table = r!.target_type === 'media' ? 'media' : 'packs';
    if (b.action === 'remove') {
      db.prepare(`UPDATE ${table} SET status = 'removed'${table === 'media' ? ', removed_reason = ?' : ''} WHERE id = ?`).run(...(table === 'media' ? [r!.reason, r!.target_id] : [r!.target_id]));
    } else if (b.action === 'restore') {
      db.prepare(`UPDATE ${table} SET status = 'active'${table === 'media' ? ', removed_reason = NULL' : ''} WHERE id = ?`).run(r!.target_id);
    }
    db.prepare('UPDATE reports SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(
      b.action === 'dismiss' ? 'dismissed' : 'actioned',
      (b.note ?? '').slice(0, 2000),
      admin.id,
      Date.now(),
      r!.id,
    );
    audit(db, admin.id, `report.${b.action}`, r!.id, { target: `${r!.target_type}:${r!.target_id}`, note: b.note });
    return c.json({ ok: true });
  });

  app.post('/api/admin/users/:id/ban', json, async (c) => {
    const admin = requireAdmin(c);
    const { banned = true } = await c.req.json<{ banned?: boolean }>().catch(() => ({ banned: true }));
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, c.req.param('id'));
    if (banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(c.req.param('id'));
    audit(db, admin.id, banned ? 'user.ban' : 'user.unban', c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/admin/audit', (c) => {
    requireAdmin(c);
    return c.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all());
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}
