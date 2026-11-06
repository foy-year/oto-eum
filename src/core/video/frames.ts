/**
 * Decoded-frame cache backed by Mediabunny (WebCodecs).
 *
 * Frames are decoded in sorted batches (`ensure`) and stored as ImageBitmaps
 * in an LRU, so drawing (`get`) is synchronous — required for smooth preview
 * and for deterministic export.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { quantizeTime } from './timeline';

export interface FrameProvider {
  /** Synchronous lookup of an already-decoded frame. */
  get(sourceId: string, time: number): ImageBitmap | null;
  /** Decode (if needed) all of the given frame times for a source. */
  ensure(sourceId: string, times: number[]): Promise<void>;
  fpsOf(sourceId: string): number;
  dispose(): void;
}

interface SourceEntry {
  input: Input;
  sink: CanvasSink;
  fps: number;
}

export class MediaFrameProvider implements FrameProvider {
  private sources = new Map<string, Promise<SourceEntry | null>>();
  private fps = new Map<string, number>();
  private cache = new Map<string, ImageBitmap>();

  constructor(
    private loadBlob: (sourceId: string) => Promise<Blob>,
    private opts: { maxWidth?: number; maxHeight?: number; capacity?: number } = {},
  ) {}

  fpsOf(id: string) {
    return this.fps.get(id) ?? 30;
  }

  private key(id: string, t: number) {
    return `${id}@${quantizeTime(t, this.fpsOf(id)).toFixed(4)}`;
  }

  /** Must be awaited once per source before fpsOf() is accurate. */
  open(id: string): Promise<SourceEntry | null> {
    let p = this.sources.get(id);
    if (!p) {
      p = (async () => {
        const blob = await this.loadBlob(id);
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) return null;
        const stats = await track.computePacketStats(120).catch(() => null);
        const fps = stats?.averagePacketRate && Number.isFinite(stats.averagePacketRate) ? stats.averagePacketRate : 30;
        this.fps.set(id, Math.min(120, Math.max(1, Math.round(fps * 1000) / 1000)));
        const mw = this.opts.maxWidth ?? 1280;
        const mh = this.opts.maxHeight ?? 720;
        const [dw, dh] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
        const scale = Math.min(1, mw / dw, mh / dh);
        const sink = new CanvasSink(track, { width: Math.max(2, Math.round(dw * scale)), height: Math.max(2, Math.round(dh * scale)), fit: 'fill' });
        return { input, sink, fps };
      })();
      this.sources.set(id, p);
    }
    return p;
  }

  get(id: string, time: number): ImageBitmap | null {
    const k = this.key(id, time);
    const bmp = this.cache.get(k);
    if (bmp) {
      // refresh LRU position
      this.cache.delete(k);
      this.cache.set(k, bmp);
    }
    return bmp ?? null;
  }

  async ensure(id: string, times: number[]): Promise<void> {
    const src = await this.open(id);
    if (!src) return;
    const fps = this.fpsOf(id);
    const missing = [...new Set(times.map((t) => quantizeTime(t, fps)))].filter((t) => !this.cache.has(this.key(id, t))).sort((a, b) => a - b);
    if (!missing.length) return;
    let i = 0;
    // offset by half a frame so we land inside the frame, not on its edge
    for await (const wc of src.sink.canvasesAtTimestamps(missing.map((t) => t + 0.5 / fps))) {
      const t = missing[i++];
      if (!wc) continue;
      const bmp = await createImageBitmap(wc.canvas);
      this.cache.set(this.key(id, t), bmp);
      this.evict();
    }
  }

  private evict() {
    const cap = this.opts.capacity ?? 900;
    while (this.cache.size > cap) {
      const [k, bmp] = this.cache.entries().next().value as [string, ImageBitmap];
      bmp.close();
      this.cache.delete(k);
    }
  }

  dispose() {
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
    for (const p of this.sources.values()) p.then((s) => s?.input.dispose()).catch(() => {});
    this.sources.clear();
  }
}
