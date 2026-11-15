/**
 * Pixel access to video frames in the browser (WebCodecs via Mediabunny):
 * sequential RGBA frames for analysis (piano-roll reading, thumbnails).
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { RgbFrame } from '../analysis/pianoRoll';

export interface VideoPixels {
  width: number;
  height: number;
  duration: number;
  /** Frames at a fixed rate, in order. Each yielded frame owns its buffer. */
  frames(fps: number, from?: number, to?: number): AsyncGenerator<RgbFrame & { time: number; index: number }>;
  frameAt(time: number): Promise<RgbFrame | null>;
  dispose(): void;
}

function toRgb(c: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): RgbFrame {
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, channels: 4, data: img.data };
}

export async function openVideoPixels(blob: Blob, maxWidth = 640): Promise<VideoPixels> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track');
  if (!(await track.canDecode())) throw new Error('This browser cannot decode the video');
  const [dw, dh] = [await track.getDisplayWidth(), await track.getDisplayHeight()];
  const scale = Math.min(1, maxWidth / dw);
  const width = Math.max(2, Math.round(dw * scale));
  const height = Math.max(2, Math.round(dh * scale));
  const sink = new CanvasSink(track, { width, height, fit: 'fill' });
  const duration = await input.computeDuration();
  return {
    width,
    height,
    duration,
    async *frames(fps: number, from = 0, to = duration) {
      // frame i ↔ time from + i/fps (tiny epsilon so we land inside the frame)
      const n = Math.floor((to - from) * fps);
      const times = Array.from({ length: n }, (_, i) => from + i / fps + 0.0005);
      let i = 0;
      let last: RgbFrame | null = null;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        const t = times[i];
        // keep indices contiguous: a missing frame repeats the previous one
        const prev = last as RgbFrame | null;
        const f: RgbFrame | null = wc ? toRgb(wc.canvas, width, height) : prev ? { width: prev.width, height: prev.height, channels: prev.channels, data: new Uint8ClampedArray(prev.data) } : null;
        if (f) {
          last = f;
          yield { ...f, time: t, index: i };
        }
        i++;
      }
    },
    async frameAt(time: number) {
      const wc = await sink.getCanvas(time);
      return wc ? toRgb(wc.canvas, width, height) : null;
    },
    dispose: () => input.dispose(),
  };
}
