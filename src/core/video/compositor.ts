/** Draws one output frame from VideoEvents (+ pulses and texts). Shared by preview and export. */
import type { Pulse, TextOverlay, VideoEvent, VideoSyncSettings } from '../types';
import { activeAt, framesNeeded, pulseState, visualState } from './timeline';
import type { FrameProvider } from './frames';
import { drawText } from './text';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameExtras {
  pulses?: Pulse[];
  texts?: TextOverlay[];
}

export function drawFrame(
  ctx: Ctx2D,
  events: VideoEvent[],
  t: number,
  frames: FrameProvider,
  settings: Pick<VideoSyncSettings, 'background'> & Partial<Pick<VideoSyncSettings, 'pulseFlash' | 'pulseZoom' | 'pulseShake'>>,
  extras: FrameExtras = {},
): number {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.fillStyle = settings.background;
  ctx.fillRect(0, 0, W, H);
  // screen-wide pulse: zoom + shake around the centre
  const pulse = extras.pulses?.length ? pulseState(extras.pulses, t, settings) : null;
  if (pulse && (pulse.zoom !== 1 || pulse.dx || pulse.dy)) {
    ctx.translate(W / 2 + pulse.dx * W, H / 2 + pulse.dy * H);
    ctx.scale(pulse.zoom, pulse.zoom);
    ctx.translate(-W / 2, -H / 2);
  }
  let missing = 0;
  for (const a of activeAt(events, t)) {
    const img = frames.get(a.ev.sourceId, a.sourceTime);
    if (!img) {
      missing++;
      continue;
    }
    const { scale, flash, opacity, dx, dy, grey } = visualState(a);
    const r = a.ev.rect;
    const cx = r.x * W;
    const cy = r.y * H;
    const cw = r.w * W;
    const ch = r.h * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
    ctx.translate(cx + cw / 2 + dx * cw, cy + ch / 2 + dy * ch);
    if (a.ev.rotate) ctx.rotate((a.ev.rotate * Math.PI) / 180);
    ctx.scale((a.ev.flipX ? -1 : 1) * scale, (a.ev.flipY ? -1 : 1) * scale);
    const filters: string[] = [];
    if (a.ev.hue) filters.push(`hue-rotate(${a.ev.hue}deg)`);
    if (flash > 0.001) filters.push(`brightness(${1 + flash})`);
    if (a.ev.invert) filters.push('invert(1)');
    if (grey) filters.push('grayscale(1)');
    ctx.filter = filters.length ? filters.join(' ') : 'none';
    ctx.globalAlpha = opacity;
    // cover-fit (a rotated frame needs extra cover so no corners show)
    const rot = a.ev.rotate ? Math.abs(Math.sin((a.ev.rotate * Math.PI) / 180)) : 0;
    const s = Math.max(cw / img.width, ch / img.height) * (1 + rot * 0.8);
    const iw = img.width * s;
    const ih = img.height * s;
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
  }
  ctx.restore();
  if (pulse && pulse.flash > 0.002) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.85, pulse.flash);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  for (const o of extras.texts ?? []) drawText(ctx, o, t);
  return missing;
}

/** Decode everything needed for [t0, t1). */
export async function prepareRange(events: VideoEvent[], frames: FrameProvider & { open?: (id: string) => Promise<unknown> }, t0: number, t1: number, fps: number): Promise<void> {
  const ids = [...new Set(events.map((e) => e.sourceId))];
  if (frames.open) await Promise.all(ids.map((id) => frames.open!(id)));
  const need = framesNeeded(events, t0, t1, fps, (id) => frames.fpsOf(id));
  for (const [id, times] of need) await frames.ensure(id, times);
}
