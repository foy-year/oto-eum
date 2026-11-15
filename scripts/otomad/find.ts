// List sample candidates in a WAV: vite-node scripts/otomad/find.ts file.wav
import { readFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { findSyllables } from '../../src/core/analysis/sampleFinder';
import { midiToName } from '../../src/core/analysis/pitch';
const pcm = decodeWav(readFileSync(process.argv[2]));
const t0 = performance.now();
const c = findSyllables(pcm, { limit: 12 });
console.log(`${(performance.now() - t0).toFixed(0)} ms`);
for (const s of c) console.log(`${s.start.toFixed(2)}–${s.end.toFixed(2)}  steady ${s.steadyStart.toFixed(2)}–${s.steadyEnd.toFixed(2)}  ${midiToName(s.rootMidi)} ${((s.rootMidi - Math.round(s.rootMidi)) * 100).toFixed(0)}c  spread ${s.spread.toFixed(2)}  score ${s.score.toFixed(2)}`);
