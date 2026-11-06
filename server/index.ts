/** Entry point: `node server/index.ts` (Node ≥ 22.18 runs TypeScript directly). */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { LocalDiskStorage } from './storage.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const db = openDb(config.dataDir);
const storage = new LocalDiskStorage(config.dataDir);
const app = createApp({ config, db, storage });

if (config.staticDir && existsSync(config.staticDir)) {
  // single-origin deployment: API + built frontend
  const root = relative(process.cwd(), config.staticDir) || '.';
  app.use('/*', serveStatic({ root }));
  const index = readFileSync(join(config.staticDir, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`oto-eum server on http://localhost:${info.port}  (data: ${config.dataDir})`);
  if (config.staticDir) console.log(`serving frontend from ${config.staticDir}`);
});
