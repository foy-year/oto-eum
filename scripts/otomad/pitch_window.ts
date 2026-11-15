// Print a compact pitch contour for windows of a source: time  note  confidence  rms
import { readFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { slice } from '../../src/core/audio/pcm';
import { trackPitch, hzToMidi, midiToName } from '../../src/core/analysis/pitch';
const pcm = decodeWav(readFileSync(process.argv[2]));
for (const w of process.argv.slice(3)) {
  const [a, b] = w.split('-').map(Number);
  const fr = trackPitch(slice(pcm, a, b), { minHz: 70, maxHz: 1000, threshold: 0.25, hop: 480 });
  const line = fr.map((f) => (f.f0 > 0 && f.confidence > 0.7 ? midiToName(hzToMidi(f.f0)).padEnd(4) : f.rms > 0.05 ? ' ~  ' : ' .  '));
  console.log(`\n== ${w}`);
  for (let i = 0; i < line.length; i += 20) console.log((a + fr[i].time).toFixed(2).padStart(6), line.slice(i, i + 20).join(''));
}
