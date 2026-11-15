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
  return medianColumn(columnDiff(a, b, r), r);
}
function medianColumn(col: Float32Array, r: Rect4): number {
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
  return playheadFromColumns(columnDiff(prev, cur, roi), roi, maxWidth);
}
function playheadFromColumns(col: Float32Array, roi: Rect4, maxWidth = 12): number | null {
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

/** Fit the playhead samples that fall inside frames [from, to]. */
export function fitPage(heads: ArrayLike<number | null>, from: number, to: number, fps: number): Page | null {
  const pts: Array<[number, number]> = [];
  for (let i = from + 1; i <= to; i++) {
    const x = heads[i];
    if (x != null) pts.push([(i - 0.5) / fps, x]);
  }
  const fit = robustLine(pts);
  if (!fit || fit.b <= 0) return null;
  const t0 = from / fps;
  return { startFrame: from, endFrame: to, t0, x0: fit.a + fit.b * t0, v: fit.b, playheadSamples: fit.n };
}

/**
 * Streaming pass over a piano-roll video. Push frames in order (the scanner
 * keeps at most 7 of them), then call finish() to get the pages and which
 * frame indices to fetch for each page's playhead-free composite.
 * Works for any length of video in constant memory.
 */
export class RollScanner {
  private cfg: PianoRollConfig;
  private fps: number;
  private ring: RgbFrame[] = [];
  private diffs: number[] = [];
  private heads: Array<number | null> = [];
  private persistent: boolean[] = [];
  count = 0;
  constructor(cfg: PianoRollConfig, fps: number) {
    this.cfg = cfg;
    this.fps = fps;
  }

  /** Takes ownership of the frame (do not reuse its buffer). */
  push(f: RgbFrame): void {
    const prev = this.ring[this.ring.length - 1];
    if (prev) {
      const col = columnDiff(prev, f, this.cfg.roi);
      this.diffs.push(medianColumn(col, this.cfg.roi));
      this.heads.push(playheadFromColumns(col, this.cfg.roi));
    } else {
      this.diffs.push(0);
      this.heads.push(null);
    }
    this.persistent.push(false);
    this.ring.push(f);
    if (this.ring.length > 7) this.ring.shift();
    this.count++;
    // a picture change at i is "persistent" if frames i-3 and i+3 differ (not a one-frame glitch)
    const i = this.count - 4;
    if (i >= 1 && this.diffs[i] > 2.5 && this.ring.length === 7) this.persistent[i] = pageChange(this.ring[0], this.ring[6], this.cfg.roi) >= 6;
  }

  finish(): { pages: Page[]; picks: Array<[number, number, number]> } {
    const n = this.count;
    // tail frames that never got a full ±3 window
    for (let i = Math.max(1, n - 3); i < n; i++) if (this.diffs[i] > 2.5 && this.ring.length) this.persistent[i] = pageChange(this.ring[0], this.ring[this.ring.length - 1], this.cfg.roi) >= 6;
    const flip = this.persistent.slice();
    // page flips: the playhead jumps backwards (reliable even on sparse rolls)
    const roiW = this.cfg.roi.x1 - this.cfg.roi.x0;
    let lastX: number | null = null;
    let lastI = 0;
    for (let i = 1; i < n; i++) {
      const x = this.heads[i];
      if (x == null) continue;
      if (lastX != null && x < lastX - 0.3 * roiW) {
        let k = lastI + 1;
        for (let j = lastI + 1; j <= i; j++) if (this.diffs[j] > this.diffs[k]) k = j;
        flip[k] = true;
      }
      lastX = x;
      lastI = i;
    }
    const segs = segmentPages(flip.map((f) => (f ? 1 : 0)), this.fps, 0.5);
    const pages: Page[] = [];
    const picks: Array<[number, number, number]> = [];
    for (const [a, b] of segs) {
      const page = fitPage(this.heads, a, b, this.fps);
      if (!page) continue;
      pages.push(page);
      picks.push([0.2, 0.5, 0.8].map((q) => Math.round(a + (b - a) * q)) as [number, number, number]);
    }
    return { pages, picks };
  }
}

/** Notes of every page (from its composite frame), merged across page flips, as tracks. */
export function notesFromPages(pages: Page[], composites: RgbFrame[], cfg: PianoRollConfig): ReadResult {
  const notes: RollNote[] = [];
  pages.forEach((page, pi) => {
    const tOf = (x: number) => page.t0 + (x - page.x0) / page.v;
    for (const n of extractNotes(composites[pi], cfg)) {
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
  });
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

/** Full pipeline over random-access frames (scripts/tests). Browser code streams via RollScanner. */
export function readPianoRollVideo(get: FrameSource, count: number, fps: number, cfg: PianoRollConfig, onProgress?: (msg: string) => void): ReadResult {
  const sc = new RollScanner(cfg, fps);
  for (let i = 0; i < count; i++) sc.push(get(i));
  const { pages, picks } = sc.finish();
  onProgress?.(`${pages.length} pages`);
  const comps = picks.map(([a, b, c]) => median3(get(a), get(b), get(c)));
  return notesFromPages(pages, comps, cfg);
}

// ---------------------------------------------------------------------------
// Calibration helpers (used by the UI to set up a reader in a few clicks)
// ---------------------------------------------------------------------------

/** Pixels that look like notes: saturated and bright. */
function isNotePixel(r: number, g: number, b: number, minS = 0.2, minV = 0.45) {
  const [, s, v] = rgbToHsv(r, g, b);
  return s >= minS && v >= minV;
}

export interface RowGrid {
  semitonePx: number;
  /** y of one row centre (any row). */
  rowCenterY: number;
  /** Pitch class (0 = C) of the row at rowCenterY, from the black/white key shading. */
  pitchClass: number | null;
  /** 0..1: how periodic the background is. */
  confidence: number;
  /** -1..1: how well the rows match the keyboard's black/white pattern. */
  keyPatternMatch: number;
}

/**
 * Row grid from the editor's background: piano rolls shade black-key rows
 * (Domino, FL Studio, Cubase, Studio One…), so the background repeats every
 * octave. That gives the semitone spacing, the row phase, and the pitch class
 * of every row — only the octave is left to choose.
 */
export function detectRowGrid(frames: RgbFrame[], roi: Rect4): RowGrid | null {
  const H = roi.y1 - roi.y0;
  const sum = new Float64Array(H);
  const cnt = new Float64Array(H);
  for (const f of frames)
    for (let y = roi.y0; y < roi.y1; y++)
      for (let x = roi.x0; x < roi.x1; x += 2) {
        const [r, g, b] = px(f, x, y);
        const [, sat, v] = rgbToHsv(r, g, b);
        if (sat < 0.12) {
          sum[y - roi.y0] += v;
          cnt[y - roi.y0]++;
        }
      }
  const bg = Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : NaN));
  const valid = bg.filter((v) => !Number.isNaN(v));
  if (valid.length < H * 0.5) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const p = bg.map((v) => (Number.isNaN(v) ? 0 : v - mean));
  const dft = (period: number) => {
    let re = 0;
    let im = 0;
    for (let y = 0; y < H; y++) {
      const a = (2 * Math.PI * y) / period;
      re += p[y] * Math.cos(a);
      im -= p[y] * Math.sin(a);
    }
    return { mag: Math.hypot(re, im), ang: Math.atan2(im, re) };
  };
  // octave period: strongest periodicity between 12×3 px and the ROI height / 1.5
  let octave = 0;
  let best = 0;
  let total = 0;
  let n = 0;
  for (let O = 36; O <= Math.min(480, H / 1.5); O += 0.1) {
    const m = dft(O).mag;
    total += m;
    n++;
    if (m > best) [best, octave] = [m, O];
  }
  if (!octave) return null;
  // refine at the semitone harmonic (12× more cycles in the window → far more precise)
  let semitonePx = octave / 12;
  let semiMag = 0;
  for (let P = (octave / 12) * 0.92; P <= (octave / 12) * 1.08; P += 0.002) {
    const m = dft(P).mag;
    if (m > semiMag) [semiMag, semitonePx] = [m, P];
  }
  // row phase: at the semitone frequency the background peaks mid-row (dark separators at the edges)
  const { ang } = dft(semitonePx);
  let rowCenterY = roi.y0 + ((((-ang / (2 * Math.PI)) * semitonePx) % semitonePx) + semitonePx) % semitonePx;
  // brightness of each row's interior
  const rows: Array<{ y: number; v: number }> = [];
  for (let y = rowCenterY; y < roi.y1 - 1; y += semitonePx) {
    let s2 = 0;
    let c2 = 0;
    for (let dy = -semitonePx * 0.25; dy <= semitonePx * 0.25; dy += 0.5) {
      const v = bg[Math.round(y + dy) - roi.y0];
      if (!Number.isNaN(v)) {
        s2 += v;
        c2++;
      }
    }
    if (c2) rows.push({ y, v: s2 / c2 });
  }
  // match the keyboard pattern; rows go DOWN in pitch from the top
  const WHITE = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1]; // C C# D … B
  let bestPc = 0;
  let bestCorr = -2;
  const mv = rows.reduce((a, r) => a + r.v, 0) / Math.max(1, rows.length);
  for (let pc = 0; pc < 12; pc++) {
    let num = 0;
    let da = 0;
    let db = 0;
    rows.forEach((r, k) => {
      const w = WHITE[(((pc - k) % 12) + 12) % 12] - 7 / 12;
      num += w * (r.v - mv);
      da += w * w;
      db += (r.v - mv) ** 2;
    });
    const corr = da && db ? num / Math.sqrt(da * db) : 0;
    if (corr > bestCorr) [bestCorr, bestPc] = [corr, pc];
  }
  rowCenterY = rows.length ? rows[0].y : rowCenterY;
  return {
    semitonePx,
    rowCenterY,
    pitchClass: bestCorr > 0.5 ? bestPc : null,
    confidence: Math.min(1, best / (3 * (total / n))),
    keyPatternMatch: bestCorr,
  };
}

/**
 * detectRowGrid over many frames, robust to frames that are not the roll
 * (title cards, fades, dialogs): per-frame detection, keep the frames whose
 * rows match the keyboard pattern, take the median spacing and phase.
 */
export function detectRowGridConsensus(frames: RgbFrame[], roi: Rect4): RowGrid | null {
  const per = frames.map((f) => detectRowGrid([f], roi)).filter((g): g is RowGrid => !!g);
  if (!per.length) return null;
  const good = per.filter((g) => g.keyPatternMatch > 0.5);
  const use = good.length ? good : per;
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
  const semitonePx = med(use.map((g) => g.semitonePx));
  const agree = use.filter((g) => Math.abs(g.semitonePx - semitonePx) / semitonePx < 0.02);
  // phase: express each frame's row centre relative to the first, modulo the spacing
  const ref = agree[0].rowCenterY;
  const phases = agree.map((g) => ref + ((((g.rowCenterY - ref) % semitonePx) + semitonePx * 1.5) % semitonePx) - semitonePx / 2);
  const rowCenterY = med(phases);
  // pitch class of that row by vote
  const votes = new Map<number, number>();
  for (const g of agree)
    if (g.pitchClass != null) {
      const k = Math.round((g.rowCenterY - rowCenterY) / semitonePx);
      const pc = (((g.pitchClass + k) % 12) + 12) % 12;
      votes.set(pc, (votes.get(pc) ?? 0) + 1);
    }
  const pitchClass = votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  return {
    semitonePx,
    rowCenterY,
    pitchClass,
    confidence: agree.length / per.length,
    keyPatternMatch: med(agree.map((g) => g.keyPatternMatch)),
  };
}

export interface HueCluster {
  hueFrom: number;
  hueTo: number;
  /** Representative colour, for display. */
  rgb: [number, number, number];
  share: number;
  /** Mostly thin vertical lines (bar lines / grid), not notes. */
  likelyGrid: boolean;
}

/** Suggest one hue range per track from the colours present in the note area. */
export function suggestTrackHues(frames: RgbFrame[], roi: Rect4): HueCluster[] {
  const BINS = 72; // 5° bins
  const hist = new Float64Array(BINS);
  const sums = Array.from({ length: BINS }, () => [0, 0, 0]);
  const vRun = new Float64Array(BINS);
  const hRun = new Float64Array(BINS);
  let total = 0;
  for (const f of frames)
    for (let y = roi.y0 + 1; y < roi.y1 - 1; y += 2)
      for (let x = roi.x0 + 1; x < roi.x1 - 1; x += 2) {
        const [r, g, b] = px(f, x, y);
        if (!isNotePixel(r, g, b)) continue;
        const [h] = rgbToHsv(r, g, b);
        const k = Math.floor(h / (360 / BINS)) % BINS;
        hist[k]++;
        sums[k][0] += r;
        sums[k][1] += g;
        sums[k][2] += b;
        total++;
        // neighbours of the same colour class: vertical vs horizontal
        const same = (xx: number, yy: number) => {
          const [r2, g2, b2] = px(f, xx, yy);
          return isNotePixel(r2, g2, b2) && Math.abs(rgbToHsv(r2, g2, b2)[0] - h) < 12;
        };
        if (same(x, y - 1) && same(x, y + 1)) vRun[k]++;
        if (same(x - 1, y) && same(x + 1, y)) hRun[k]++;
      }
  if (!total) return [];
  // smooth circularly, find peaks, grow each to its valleys
  const sm = Array.from(hist, (_, i) => (hist[(i + BINS - 1) % BINS] + 2 * hist[i] + hist[(i + 1) % BINS]) / 4);
  const out: HueCluster[] = [];
  const taken = new Uint8Array(BINS);
  const order = sm.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [v, i] of order) {
    if (taken[i] || v < total * 0.0025) continue;
    let lo = i;
    let hi = i;
    while (!taken[(lo + BINS - 1) % BINS] && sm[(lo + BINS - 1) % BINS] > total * 0.002 && sm[(lo + BINS - 1) % BINS] <= sm[lo] * 1.05 && (i - lo + BINS) % BINS < 10) lo = (lo + BINS - 1) % BINS;
    while (!taken[(hi + 1) % BINS] && sm[(hi + 1) % BINS] > total * 0.002 && sm[(hi + 1) % BINS] <= sm[hi] * 1.05 && (hi - i + BINS) % BINS < 10) hi = (hi + 1) % BINS;
    let n = 0;
    const rgb = [0, 0, 0];
    let vr = 0;
    let hr = 0;
    for (let k = lo; ; k = (k + 1) % BINS) {
      taken[k] = 1;
      n += hist[k];
      for (let c = 0; c < 3; c++) rgb[c] += sums[k][c];
      vr += vRun[k];
      hr += hRun[k];
      if (k === hi) break;
    }
    if (n < total * 0.0025) continue;
    out.push({
      hueFrom: (lo * 360) / BINS,
      hueTo: (((hi + 1) * 360) / BINS) % 360 || 360,
      rgb: rgb.map((c) => Math.round(c / n)) as [number, number, number],
      share: n / total,
      likelyGrid: vr > 3 * Math.max(1, hr),
    });
  }
  // widen each range to halfway towards its neighbouring colours (max ±25° from its centre)
  const centre = (c: HueCluster) => (c.hueFrom + (((c.hueTo - c.hueFrom) % 360) + 360) % 360 / 2) % 360;
  const byHue = out.map((c) => ({ c, h: centre(c) })).sort((a, b) => a.h - b.h);
  byHue.forEach(({ c, h }, i) => {
    if (byHue.length === 1) {
      c.hueFrom = (h - 25 + 360) % 360;
      c.hueTo = (h + 25) % 360;
      return;
    }
    const prev = byHue[(i - 1 + byHue.length) % byHue.length].h;
    const next = byHue[(i + 1) % byHue.length].h;
    const gapPrev = ((h - prev) % 360 + 360) % 360 || 360;
    const gapNext = ((next - h) % 360 + 360) % 360 || 360;
    c.hueFrom = (h - Math.min(25, gapPrev / 2) + 360) % 360;
    c.hueTo = (h + Math.min(25, gapNext / 2 - 0.01) + 360) % 360;
  });
  return out.sort((a, b) => b.share - a.share);
}

/** Plain colour name for a hue (for default track names). */
export function hueName(h: number): string {
  const names: Array<[number, string]> = [[15, 'Red'], [40, 'Orange'], [70, 'Yellow'], [150, 'Green'], [195, 'Cyan'], [255, 'Blue'], [290, 'Purple'], [335, 'Pink'], [360, 'Red']];
  return names.find(([max]) => h < max)![1];
}

/** Row centre nearest to y (snap a click to the note grid). */
export function snapToRow(y: number, grid: { semitonePx: number; rowCenterY: number }): number {
  return grid.rowCenterY + Math.round((y - grid.rowCenterY) / grid.semitonePx) * grid.semitonePx;
}
