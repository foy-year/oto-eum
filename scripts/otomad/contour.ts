import { readFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { slice } from '../../src/core/audio/pcm';
import { trackPitch, hzToMidi } from '../../src/core/analysis/pitch';
const pcm = decodeWav(readFileSync(process.argv[2]));
for (const w of process.argv.slice(3)) {
  const [a, b] = w.split('-').map(Number);
  const fr = trackPitch(slice(pcm, a - 0.05, b + 0.05), { minHz: 70, maxHz: 1000, threshold: 0.3, hop: 160 });
  console.log(`== ${w}`);
  console.log(fr.filter((f) => f.time > 0.04).map((f) => `${(a - 0.05 + f.time).toFixed(2)}:${f.f0 > 0 ? hzToMidi(f.f0).toFixed(1) : '--'}`).join(' '));
}
