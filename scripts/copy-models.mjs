// Copies the Basic Pitch model (Apache-2.0) into public/ so it is served statically.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = dirname(require.resolve('@spotify/basic-pitch/package.json'));
const dest = join(process.cwd(), 'public', 'models', 'basic-pitch');
if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
cpSync(join(pkg, 'model'), dest, { recursive: true });
console.log('Basic Pitch model copied to', dest);
