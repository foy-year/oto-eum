// Align reference recordings with a song (chroma), searching offset + key shift; report local agreement over time.
//   vite-node scripts/otomad/ref_align.ts <song.wav> <ref1.wav> [ref2.wav …]
import { readFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { chromagram } from '../../src/core/analysis/align';

const corr = (a: Float32Array, b: Float32Array, shift: number) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[(i + shift) % 12]; }
  ma /= 12; mb /= 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[(i + shift) % 12] - mb; n += x * y; da += x * x; db += y * y; }
  return da && db ? n / Math.sqrt(da * db) : 0;
};
const song = chromagram(decodeWav(readFileSync(process.argv[2])));
for (const f of process.argv.slice(3)) {
  const ref = chromagram(decodeWav(readFileSync(f)));
  const hop = ref.hop;
  let best = { lag: 0, shift: 0, score: -1 };
  for (let shift = 0; shift < 12; shift++)
    for (let lag = -Math.round(5 / hop); lag < ref.frames.length - 50; lag += 2) {
      let s = 0, n = 0;
      for (let i = 30; i < song.frames.length; i += 3) {
        const j = i + lag;
        if (j < 0 || j >= ref.frames.length) continue;
        s += corr(song.frames[i], ref.frames[j], shift); n++;
      }
      if (n > 100 && s / n > best.score) best = { lag, shift, score: s / n };
    }
  // local agreement per 2 s window of the reference (song looped to cover the whole reference)
  const L = song.frames.length;
  const win: string[] = [];
  for (let t = 0; t < ref.frames.length * hop; t += 2) {
    let s = 0, n = 0;
    for (let j = Math.round(t / hop); j < Math.min(ref.frames.length, Math.round((t + 2) / hop)); j++) {
      const i = j - best.lag;
      if (i < 0 || i >= L) continue;
      s += corr(song.frames[i], ref.frames[j], best.shift); n++;
    }
    win.push(n ? (s / n).toFixed(1).replace('0.', '.') : ' -- ');
  }
  const name = f.split('/').pop();
  console.log(`${name}: song starts at ${(best.lag * hop).toFixed(2)} s, key ${best.shift ? '+' + best.shift : 'same'}, agreement ${best.score.toFixed(2)} | per 2 s: ${win.join(' ')}`);
}
