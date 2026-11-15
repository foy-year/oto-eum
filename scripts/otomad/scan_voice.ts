// Find pitched, stable syllables in a source (candidates for 音MAD samples).
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeWav } from '../../src/core/audio/wav';
import { trackPitch, hzToMidi, midiToName } from '../../src/core/analysis/pitch';
import { detectOnsets } from '../../src/core/analysis/onset';
import { rms, slice } from '../../src/core/audio/pcm';

const pcm = decodeWav(readFileSync(process.argv[2]));
const frames = trackPitch(pcm, { minHz: 70, maxHz: 900, threshold: 0.2 });
const { onsets } = detectOnsets(pcm, { sensitivity: 1.2, minInterval: 0.06 });
// voiced runs
type Seg = { start: number; end: number; midi: number; spread: number; loud: number };
const segs: Seg[] = [];
let cur: { s: number; ms: number[]; r: number[] } | null = null;
const hop = frames[1].time - frames[0].time;
for (const f of [...frames, { time: Infinity, f0: 0, confidence: 0, rms: 0 }]) {
  if (f.f0 > 0) {
    const m = hzToMidi(f.f0);
    if (cur && Math.abs(m - cur.ms[cur.ms.length - 1]) < 1.2) { cur.ms.push(m); cur.r.push(f.rms); continue; }
    if (cur) close(f.time);
    cur = { s: f.time, ms: [m], r: [f.rms] };
  } else if (cur) close(f.time);
}
function close(_t: number) {
  if (!cur) return;
  const ms = cur.ms.slice().sort((a, b) => a - b);
  const dur = cur.ms.length * hop;
  if (dur >= 0.08) segs.push({ start: cur.s - hop / 2, end: cur.s - hop / 2 + dur, midi: ms[ms.length >> 1], spread: ms[Math.floor(ms.length * 0.9)] - ms[Math.floor(ms.length * 0.1)], loud: Math.max(...cur.r) });
  cur = null;
}
for (const s of segs) console.log(`${s.start.toFixed(2)}-${s.end.toFixed(2)} (${(s.end - s.start).toFixed(2)}s) ${midiToName(s.midi)} ${s.midi.toFixed(1)} spread=${s.spread.toFixed(2)} loud=${s.loud.toFixed(3)}`);
console.log('onsets', onsets.map((t) => t.toFixed(2)).join(' '));
const total = pcm.channels[0].length / pcm.sampleRate;
const env: string[] = [];
for (let t = 0; t < total; t += 0.5) env.push(`${t.toFixed(1)}:${rms(slice(pcm, t, t + 0.5).channels[0]).toFixed(3)}`);
console.log('rms', env.join(' '));
writeFileSync(process.argv[3], JSON.stringify({ segs, onsets }));
