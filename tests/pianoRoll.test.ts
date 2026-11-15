import { describe, expect, it } from 'vitest';
import { readPianoRollVideo, extractNotes, robustLine, type RgbFrame, type PianoRollConfig } from '../src/core/analysis/pianoRoll';

// Synthetic "MIDI video": 2 pages, a 1-px playhead, two coloured tracks with darker note borders.
const Wd = 200, Hd = 100, fps = 30, v = 60; // px/s
const cfg: PianoRollConfig = {
  roi: { x0: 10, x1: 190, y0: 5, y1: 95 },
  pitchRef: { y: 50, pitch: 60 },
  semitonePx: 5,
  tracks: [
    { name: 'red', hueFrom: 340, hueTo: 20 },
    { name: 'green', hueFrom: 90, hueTo: 150 },
  ],
};
// notes in absolute seconds: [track, pitch, start, end]
const NOTES: Array<[number, number, number, number]> = [
  [0, 60, 0.0, 0.5], [0, 60, 0.5, 1.0], [0, 64, 1.2, 1.8], [1, 55, 0.2, 2.6], [0, 67, 2.4, 3.6], [1, 52, 3.8, 4.4],
];
const pageSpan = (cfg.roi.x1 - cfg.roi.x0) / v; // 3 s per page
function frame(i: number): RgbFrame {
  const t = i / fps;
  const page = Math.floor(t / pageSpan);
  const p0 = page * pageSpan;
  const d = new Uint8Array(Wd * Hd * 3).fill(240);
  const put = (x: number, y: number, c: number[]) => d.set(c, (y * Wd + x) * 3);
  for (const [tr, pitch, s, e] of NOTES) {
    const xa = Math.round(cfg.roi.x0 + (s - p0) * v), xb = Math.round(cfg.roi.x0 + (e - p0) * v);
    const yc = 50 - (pitch - 60) * 5;
    for (let x = Math.max(cfg.roi.x0, xa); x < Math.min(cfg.roi.x1, xb); x++)
      for (let y = yc - 2; y <= yc + 2; y++) {
        const border = x === xa || x === xb - 1 || y === yc - 2 || y === yc + 2;
        put(x, y, tr === 0 ? (border ? [170, 60, 60] : [250, 120, 120]) : border ? [60, 150, 60] : [120, 240, 120]);
      }
  }
  const ph = Math.round(cfg.roi.x0 + (t - p0) * v);
  for (let y = cfg.roi.y0; y < cfg.roi.y1; y++) put(Math.min(cfg.roi.x1 - 1, ph), y, [20, 20, 20]);
  return { width: Wd, height: Hd, channels: 3, data: d };
}

describe('piano-roll video reader', () => {
  it('fits a line robustly', () => {
    const fit = robustLine([[0, 0], [1, 2], [2, 4], [3, 6], [4, 100]])!;
    expect(fit.b).toBeCloseTo(2);
  });

  it('splits adjacent same-pitch notes at their borders', () => {
    const notes = extractNotes(frame(45), cfg).filter((n) => n.pitch === 60);
    expect(notes).toHaveLength(2);
  });

  it('reads notes, tracks and timing across page flips', () => {
    const { tracks, pages } = readPianoRollVideo(frame, Math.round(4.6 * fps), fps, cfg);
    expect(pages).toHaveLength(2);
    pages.forEach((p) => expect(p.v).toBeCloseTo(v, 0));
    const red = tracks.find((t) => t.name === 'red')!.notes;
    const green = tracks.find((t) => t.name === 'green')!.notes;
    expect(red.map((n) => n.pitch)).toEqual([60, 60, 64, 67]);
    expect(green.map((n) => n.pitch)).toEqual([55, 52]);
    // the green note crossing the page flip (0.2–2.6 s, flip at 3 s is after it) and red 2.4–3.6 (crosses) are merged
    const crossing = red.find((n) => n.pitch === 67)!;
    expect(crossing.start).toBeCloseTo(2.4, 1);
    expect(crossing.start + crossing.duration).toBeCloseTo(3.6, 1);
    red.forEach((n, i) => expect(n.start).toBeCloseTo([0, 0.5, 1.2, 2.4][i], 1));
  });
});
