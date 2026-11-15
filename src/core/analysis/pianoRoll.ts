/**
 * Piano-roll video → MIDI.
 *
 * Many 音MAD sources come as "MIDI videos": a screen recording of a piano
 * roll editor (Domino, FL Studio, Cubase…) with a moving playhead and one
 * colour per track. Reading the picture gives far cleaner, per-track notes
 * than audio transcription of the full mix.
 *
 * Pipeline (all pure, frame access is injected so it runs in Node or the browser):
 *  1. segmentPages   — find "page flips" (the roll jumps) via frame differences
 *  2. trackPlayhead  — per page, follow the thin moving playhead and fit x(t)
 *  3. composite      — per-pixel median of 3 frames removes the playhead
 *  4. extractNotes   — scan each pitch row, classify pixels by track hue,
 *                      split runs at darker note borders
 *  5. x → time via the page's playhead fit; merge notes cut at page edges
 */
import { type Note, type NoteTrack, uid } from '../types';
import { sortNotes } from '../midi/midi';

export interface RgbFrame {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA) bytes per pixel. */
  channels: 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
}

export interface Rect4 {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface RollTrackSpec {
  name: string;
  /** Hue range in degrees; may wrap (e.g. from 340 to 12). */
  hueFrom: number;
  hueTo: number;
}

export interface PianoRollConfig {
  /** Note area of the screen (exclude keyboard, rulers, scrollbars). */
  roi: Rect4;
  /** Centre y of one known pitch row, and the pixel height of a semitone. */
  pitchRef: { y: number; pitch: number };
  semitonePx: number;
  tracks: RollTrackSpec[];
  minSaturation?: number;
  minValue?: number;
  /** Shortest note in pixels. */
  minNotePx?: number;
}

export interface Page {
  startFrame: number;
  endFrame: number;
  /** Playhead model: x = x0 + v * (t - t0). */
  t0: number;
  x0: number;
  v: number;
  playheadSamples: number;
}

export interface RollNote {
  track: number;
  pitch: number;
  start: number;
  end: number;
  velocity: number;
  cutLeft: boolean;
  cutRight: boolean;
}

const px = (f: RgbFrame, x: number, y: number): [number, number, number] => {
  const i = (y * f.width + x) * f.channels;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
};

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

const inHue = (h: number, a: number, b: number) => (a <= b ? h >= a && h <= b : h >= a || h <= b);

/** Mean absolute difference of two frames inside a rectangle (sub-sampled). */
export function frameDiff(a: RgbFrame, b: RgbFrame, r: Rect4, step = 2): number {
  let s = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y += step)
    for (let x = r.x0; x < r.x1; x += step) {
      const i = (y * a.width + x) * a.channels;
      s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      n++;
    }
  return s / (3 * n);
}

/** Per-column summed difference inside r (used to find the playhead). */
function columnDiff(a: RgbFrame, b: RgbFrame, r: Rect4): Float32Array {
  const out = new Float32Array(r.x1 - r.x0);
  for (let y = r.y0; y < r.y1; y += 2)
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * a.width + x) * a.channels;
      out[x - r.x0] += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    }
  return out;
}

export type FrameSource = (index: number) => RgbFrame;

/**
 * "How much of the page changed": median over columns of the mean per-pixel
 * difference. A moving playhead or cursor touches only a few columns and is
 * ignored; a page flip changes nearly every column.
 */
export function pageChange(a: RgbFrame, b: RgbFrame, r: Rect4): number {
  const col = columnDiff(a, b, r);
  const rows = Math.ceil((r.y1 - r.y0) / 2) * 3;
  const sorted = Array.from(col, (v) => v / rows).sort((x, y) => x - y);
  return sorted[sorted.length >> 1];
}

/**
 * Split the video into stable pages. `diffs[i]` = frameDiff(i-1, i).
 * A page is a run of frames whose consecutive differences stay under
 * `flipThreshold`, lasting at least `minPageSeconds`.
 */
export function segmentPages(diffs: number[], fps: number, flipThreshold = 2.5, minPageSeconds = 1): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= diffs.length; i++) {
    const flip = i === diffs.length || diffs[i] > flipThreshold;
    if (flip) {
      if ((i - start) / fps >= minPageSeconds) pages.push([start, i - 1]);
      start = i;
    }
  }
  return pages;
}

/** Robust line fit x = a + b t: drop the worst outlier until all residuals ≤ maxResidual. */
export function robustLine(pts: Array<[number, number]>, maxResidual = 6): { a: number; b: number; n: number } | null {
  const use = pts.slice();
  while (use.length >= 3) {
    const n = use.length;
    const mt = use.reduce((s, p) => s + p[0], 0) / n;
    const mx = use.reduce((s, p) => s + p[1], 0) / n;
    let num = 0;
    let den = 0;
    for (const [t, x] of use) {
      num += (t - mt) * (x - mx);
      den += (t - mt) ** 2;
    }
    if (den === 0) return null;
    const b = num / den;
    const a = mx - b * mt;
    let worst = 0;
    let wi = -1;
    use.forEach(([t, x], i) => {
      const r = Math.abs(a + b * t - x);
      if (r > worst) [worst, wi] = [r, i];
    });
    if (worst <= maxResidual) return { a, b, n };
    use.splice(wi, 1);
  }
  return null;
}

/** x of a thin moving playhead between two frames, or null. */
export function playheadBetween(prev: RgbFrame, cur: RgbFrame, roi: Rect4, maxWidth = 12): number | null {
  const col = columnDiff(prev, cur, roi);
  let max = 0;
  for (const v of col) max = Math.max(max, v);
  if (max <= 200) return null;
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < col.length; x++)
    if (col[x] > 0.3 * max) {
      if (lo < 0) lo = x;
      hi = x;
    }
  return hi - lo <= maxWidth ? roi.x0 + (lo + hi) / 2 : null;
}

/** Follow the playhead inside one page and fit its motion. */
export function trackPlayhead(get: FrameSource, from: number, to: number, fps: number, roi: Rect4, maxWidth = 12): Page | null {
  const pts: Array<[number, number]> = [];
  let prev = get(from);
  for (let i = from + 1; i <= to; i++) {
    const cur = get(i);
    const x = playheadBetween(prev, cur, roi, maxWidth);
    if (x != null) pts.push([(i - 0.5) / fps, x]);
    prev = cur;
  }
  const fit = robustLine(pts);
  if (!fit || fit.b <= 0) return null;
  const t0 = from / fps;
  return { startFrame: from, endFrame: to, t0, x0: fit.a + fit.b * t0, v: fit.b, playheadSamples: fit.n };
}

/** Per-pixel median of three frames (removes a moving playhead). */
export function median3(a: RgbFrame, b: RgbFrame, c: RgbFrame): RgbFrame {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) {
    const x = a.data[i];
    const y = b.data[i];
    const z = c.data[i];
    out[i] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
  }
  return { width: a.width, height: a.height, channels: a.channels, data: out };
}

export interface PixelNote {
  track: number;
  pitch: number;
  x0: number;
  x1: number;
}

/** Find note rectangles in one (playhead-free) frame. */
export function extractNotes(f: RgbFrame, cfg: PianoRollConfig): PixelNote[] {
  const { roi, pitchRef, semitonePx } = cfg;
  const minS = cfg.minSaturation ?? 0.2;
  const minV = cfg.minValue ?? 0.45;
  const minLen = cfg.minNotePx ?? 3;
  const out: PixelNote[] = [];
  const pTop = Math.floor(pitchRef.pitch + (pitchRef.y - roi.y0) / semitonePx);
  const pBot = Math.ceil(pitchRef.pitch - (roi.y1 - pitchRef.y) / semitonePx);
  for (let pitch = pBot; pitch <= pTop; pitch++) {
    const yc = Math.round(pitchRef.y - (pitch - pitchRef.pitch) * semitonePx);
    if (yc - 1 < roi.y0 || yc + 1 >= roi.y1) continue;
    const W = roi.x1 - roi.x0;
    const cls = new Int16Array(W).fill(-1);
    const val = new Float32Array(W);
    for (let x = roi.x0; x < roi.x1; x++) {
      // majority over 3 rows around the row centre
      const votes = new Map<number, number>();
      let vsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const [r, g, b] = px(f, x, yc + dy);
        const [h, s, v] = rgbToHsv(r, g, b);
        if (s < minS || v < minV) continue;
        const t = cfg.tracks.findIndex((tr) => inHue(h, tr.hueFrom, tr.hueTo));
        if (t >= 0) {
          votes.set(t, (votes.get(t) ?? 0) + 1);
          vsum += v;
        }
      }
      let best = -1;
      let bestN = 1;
      for (const [t, n] of votes) if (n > bestN) [best, bestN] = [t, n];
      cls[x - roi.x0] = best;
      val[x - roi.x0] = best >= 0 ? vsum / Math.max(1, [...votes.values()].reduce((s, n) => s + n, 0)) : 0;
    }
    // runs of one track, split at darker border pixels
    let x = 0;
    while (x < W) {
      const t = cls[x];
      if (t < 0) {
        x++;
        continue;
      }
      let e = x;
      while (e + 1 < W && cls[e + 1] === t) e++;
      const seg = Array.from(val.subarray(x, e + 1)).sort((a, b) => a - b);
      const ref = seg[Math.floor(seg.length * 0.75)];
      let s = x;
      for (let k = x; k <= e + 1; k++) {
        const border = k > e || val[k] < ref * 0.86;
        if (border) {
          if (k - s >= minLen) out.push({ track: t, pitch, x0: roi.x0 + s - 1, x1: roi.x0 + k });
          s = k + 1;
        }
      }
      x = e + 1;
    }
  }
  return out;
}

export interface ReadResult {
  tracks: NoteTrack[];
  pages: Page[];
  rawNotes: RollNote[];
}

/** Full pipeline. `count` frames at `fps`, accessed through `get`. */
export function readPianoRollVideo(get: FrameSource, count: number, fps: number, cfg: PianoRollConfig, onProgress?: (msg: string) => void): ReadResult {
  // Pass 1: picture change and playhead position for every frame.
  const diffs = [0];
  const heads: Array<number | null> = [null];
  let prev = get(0);
  for (let i = 1; i < count; i++) {
    const cur = get(i);
    diffs.push(pageChange(prev, cur, cfg.roi));
    heads.push(playheadBetween(prev, cur, cfg.roi));
    prev = cur;
  }
  // Page flips: the playhead jumps backwards (reliable even on sparse rolls) …
  const flip = new Array<boolean>(count).fill(false);
  const roiW = cfg.roi.x1 - cfg.roi.x0;
  let lastX: number | null = null;
  let lastI = 0;
  for (let i = 1; i < count; i++) {
    const x = heads[i];
    if (x == null) continue;
    if (lastX != null && x < lastX - 0.3 * roiW) {
      // the flip itself is the biggest picture change since the last sample
      let k = lastI + 1;
      for (let j = lastI + 1; j <= i; j++) if (diffs[j] > diffs[k]) k = j;
      flip[k] = true;
    }
    lastX = x;
    lastI = i;
  }
  // … or the whole picture changes and stays changed (not a one-frame glitch)
  for (let i = 1; i < count; i++) {
    if (flip[i] || diffs[i] <= 2.5) continue;
    const a = get(Math.max(0, i - 3));
    const b = get(Math.min(count - 1, i + 3));
    if (pageChange(a, b, cfg.roi) >= 6) flip[i] = true;
  }
  const segs = segmentPages(flip.map((f) => (f ? 1 : 0)), fps, 0.5);
  onProgress?.(`${segs.length} pages`);
  const pages: Page[] = [];
  const notes: RollNote[] = [];
  for (const [a, b] of segs) {
    const page = trackPlayhead(get, a, b, fps, cfg.roi);
    if (!page) continue;
    pages.push(page);
    const pick = (q: number) => get(Math.round(a + (b - a) * q));
    const comp = median3(pick(0.2), pick(0.5), pick(0.8));
    const tOf = (x: number) => page.t0 + (x - page.x0) / page.v;
    for (const n of extractNotes(comp, cfg)) {
      notes.push({
        track: n.track,
        pitch: n.pitch,
        start: tOf(n.x0),
        end: tOf(n.x1),
        velocity: 0.8,
        cutLeft: n.x0 <= cfg.roi.x0 + 1,
        cutRight: n.x1 >= cfg.roi.x1 - 1,
      });
    }
    onProgress?.(`page ${pages.length}: ${(page.v).toFixed(1)} px/s, ${page.playheadSamples} playhead samples`);
  }
  // merge notes split across page boundaries
  const merged: RollNote[] = [];
  for (const n of notes.sort((p, q) => p.start - q.start)) {
    if (n.cutLeft) {
      const prevNote = merged.find((m) => m.cutRight && m.track === n.track && m.pitch === n.pitch && Math.abs(m.end - n.start) < 0.15);
      if (prevNote) {
        prevNote.end = Math.max(prevNote.end, n.end);
        prevNote.cutRight = n.cutRight;
        continue;
      }
    }
    merged.push({ ...n });
  }
  const tracks: NoteTrack[] = cfg.tracks.map((t, i) => ({
    id: uid('t'),
    name: t.name,
    gain: 1,
    pan: 0,
    effects: [],
    notes: sortNotes(
      merged
        .filter((n) => n.track === i && n.end > n.start)
        .map((n): Note => ({ id: uid('n'), pitch: n.pitch, start: Math.max(0, n.start), duration: n.end - n.start, velocity: n.velocity })),
    ),
  }));
  return { tracks: tracks.filter((t) => t.notes.length > 0), pages, rawNotes: merged };
}
