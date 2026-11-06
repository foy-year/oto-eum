import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const key = await scrypt(pw, Buffer.from(s, 'base64'), expected.length, PARAMS);
  return timingSafeEqual(key, expected);
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export function newId(prefix: string): string {
  return prefix + randomBytes(9).toString('base64url');
}

export function createSession(db: DB, userId: string, days: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), userId, now, now + days * 86400_000);
  return token;
}

export function destroySession(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  quota_bytes: number;
  banned: number;
}

export function userForToken(db: DB, token: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.quota_bytes, u.banned FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha(token), Date.now()) as SessionUser | undefined;
  return row && !row.banned ? row : null;
}

/** Tiny fixed-window rate limiter (per key). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  // (no parameter properties: the server runs under Node's type stripping)
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    return ++h.n <= this.limit;
  }
}
