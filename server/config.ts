import { resolve } from 'node:path';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(+v) ? +v : d);
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  port: number;
  dataDir: string;
  /** Browser origins allowed to call the API (CORS). */
  corsOrigins: string[];
  maxUploadBytes: number;
  defaultQuotaBytes: number;
  /** Emails that become admins when they register. */
  adminEmails: string[];
  allowSignup: boolean;
  /** Serve the built frontend (dist/) from the same origin. */
  staticDir?: string;
  sessionDays: number;
  /** Shown in the copyright policy as the takedown contact. */
  copyrightContact: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8787),
    dataDir: resolve(env.DATA_DIR ?? './data'),
    corsOrigins: list(env.CORS_ORIGINS ?? 'http://localhost:5173,https://foy-year.github.io'),
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 500) * 1024 * 1024,
    defaultQuotaBytes: num(env.USER_QUOTA_MB, 2048) * 1024 * 1024,
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    allowSignup: env.ALLOW_SIGNUP !== 'false',
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : undefined,
    sessionDays: num(env.SESSION_DAYS, 30),
    copyrightContact: env.COPYRIGHT_CONTACT ?? 'copyright@example.com',
  };
}
