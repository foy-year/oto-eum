// vite-node scripts/otomad/drums.ts file.wav — list drum candidates in a source
import { readFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { findDrumHits } from '../../src/core/analysis/drums';
const hits = findDrumHits(decodeWav(readFileSync(process.argv[2])));
for (const [k, v] of Object.entries(hits)) console.log(k.padEnd(6), v.map((h) => `${h.time.toFixed(2)}s (score ${h.score[k as 'kick'].toFixed(3)})`).join('  '));
