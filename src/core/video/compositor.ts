/** Draws one output frame from VideoEvents. Shared by preview and export. */
import type { VideoEvent, VideoSyncSettings } from '../types';
import { activeAt, framesNeeded, visualState } from './timeline';
import type { FrameProvider } from './frames';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawFrame(ctx: Ctx2D, events: VideoEvent[], t: number, frames: FrameProvider, settings: Pick<VideoSyncSettings, 'background'>): number {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.fillStyle = settings.background;
  ctx.fillRect(0, 0, W, H);
  let missing = 0;
  for (const a of activeAt(events, t)) {
    const img = frames.get(a.ev.sourceId, a.sourceTime);
    if (!img) {
      missing++;
      continue;
    }
    const { scale, flash, opacity } = visualState(a);
    const r = a.ev.rect;
    const dx = r.x * W;
    const dy = r.y * H;
    const dw = r.w * W;
    const dh = r.h * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.scale((a.ev.flipX ? -1 : 1) * scale, (a.ev.flipY ? -1 : 1) * scale);
    if (a.ev.rotate) ctx.rotate((a.ev.rotate * Math.PI) / 180);
    const filters: string[] = [];
    if (a.ev.hue) filters.push(`hue-rotate(${a.ev.hue}deg)`);
    if (flash > 0.001) filters.push(`brightness(${1 + flash})`);
    if (a.ev.invert) filters.push('invert(1)');
    ctx.filter = filters.length ? filters.join(' ') : 'none';
    ctx.globalAlpha = opacity;
    // cover-fit the frame into the cell
    const s = Math.max(dw / img.width, dh / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
  }
  ctx.restore();
  return missing;
}

/** Decode everything needed for [t0, t1). */
export async function prepareRange(events: VideoEvent[], frames: FrameProvider & { open?: (id: string) => Promise<unknown> }, t0: number, t1: number, fps: number): Promise<void> {
  const ids = [...new Set(events.map((e) => e.sourceId))];
  if (frames.open) await Promise.all(ids.map((id) => frames.open!(id)));
  const need = framesNeeded(events, t0, t1, fps, (id) => frames.fpsOf(id));
  for (const [id, times] of need) await frames.ensure(id, times);
}
