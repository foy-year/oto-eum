import { openSync, readSync, writeFileSync, statSync } from 'node:fs';
import { readPianoRollVideo, type RgbFrame, type PianoRollConfig } from '../../src/core/analysis/pianoRoll';
import { exportMidi } from '../../src/core/midi/midi';
import { midiToName } from '../../src/core/analysis/pitch';

const W = process.argv[2];
const file = `${W}/bf/b.rgb`;
const FW = 640, FH = 360, FS = FW * FH * 3;
const count = statSync(file).size / FS;
const fd = openSync(file, 'r');
const cache = new Map<number, RgbFrame>();
const get = (i: number): RgbFrame => {
  let f = cache.get(i);
  if (!f) {
    const data = new Uint8Array(FS);
    readSync(fd, data, 0, FS, i * FS);
    f = { width: FW, height: FH, channels: 3, data };
    cache.set(i, f);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return f;
};
// Domino: the C5 row (MIDI 72) is centred at y=158 — verified by chroma + bass-octave checks against the audio
const C_REF = Number(process.argv[3] ?? 72);
const cfg: PianoRollConfig = {
  roi: { x0: 96, x1: 634, y0: 46, y1: 346 },
  pitchRef: { y: 158, pitch: C_REF },
  semitonePx: 5,
  tracks: [
    { name: 'メイン main', hueFrom: 335, hueTo: 15 },
    { name: 'ハモリ harmony', hueFrom: 22, hueTo: 50 },
    { name: 'コーラス chorus', hueFrom: 50.01, hueTo: 75 },
    { name: 'ベース bass', hueFrom: 85, hueTo: 125 },
    { name: 'アルペジオ arpeggio', hueFrom: 155, hueTo: 195 },
    { name: '音程エグいやつ wild', hueFrom: 255, hueTo: 300 },
  ],
};
const res = readPianoRollVideo(get, count, 30, cfg, (m) => console.log(m));
for (const p of res.pages) console.log(`page frames ${p.startFrame}-${p.endFrame}  x0=${p.x0.toFixed(1)} v=${p.v.toFixed(2)}`);
for (const t of res.tracks) {
  console.log(`${t.name}: ${t.notes.length} notes, range ${midiToName(Math.min(...t.notes.map((n) => n.pitch)))}–${midiToName(Math.max(...t.notes.map((n) => n.pitch)))}`);
  console.log('   ', t.notes.slice(0, 10).map((n) => `${midiToName(n.pitch)}@${n.start.toFixed(2)}+${n.duration.toFixed(2)}`).join(' '));
}
writeFileSync(`${W}/roll.json`, JSON.stringify(res.tracks));
writeFileSync(`${W}/roll.mid`, exportMidi(res.tracks, 165));
