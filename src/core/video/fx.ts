/**
 * Whole-frame video effects on a timeline: mirror, kaleidoscope, tiling,
 * radial speed lines ("集中線"), shattered-glass rays, flashes and colour
 * grading — the staples of 音MAD / YTPMV editing.
 */
import type { VideoFx } from '../types';
import { hash01 } from './timeline';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const FX_DEFAULTS: Record<VideoFx['kind'], Record<string, number>> = {
  mirror: { mode: 0 },
  kaleido: { segments: 8, spin: 30, zoom: 1.2 },
  tile: { n: 3, spin: 0, zoom: 1 },
  burst: { count: 48, inner: 0.32, alpha: 0.85 },
  glass: { count: 9, alpha: 0.9 },
  flash: { decay: 0.25, alpha: 0.9 },
  grade: { saturate: 1.5, contrast: 1.15, brightness: 1.08, hue: 0, tint: 0 },
};

/** 0..1 strength of an effect at time t (fades at both ends; flash decays). */
export function fxEnvelope(fx: VideoFx, t: number): number {
  if (t < fx.start || t >= fx.end) return 0;
  if (fx.kind === 'flash') return Math.exp(-(t - fx.start) / Math.max(0.01, fx.params.decay ?? 0.25));
  const f = fx.fade ?? 0.06;
  return f > 0 ? Math.min(1, (t - fx.start) / f, (fx.end - t) / f) : 1;
}

let scratch: OffscreenCanvas | null = null;
function copyOf(ctx: Ctx2D): OffscreenCanvas {
  const { width: W, height: H } = ctx.canvas;
  if (!scratch || scratch.width !== W || scratch.height !== H) scratch = new OffscreenCanvas(W, H);
  const g = scratch.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.drawImage(ctx.canvas, 0, 0);
  return scratch;
}

/** Apply all effects active at t, in list order. */
export function applyFx(ctx: Ctx2D, list: VideoFx[] | undefined, t: number): void {
  if (!list?.length) return;
  for (const fx of list) {
    const k = fxEnvelope(fx, t);
    if (k <= 0.001) continue;
    const p = { ...FX_DEFAULTS[fx.kind], ...fx.params };
    ctx.save();
    switch (fx.kind) {
      case 'mirror':
        mirror(ctx, p.mode, k);
        break;
      case 'kaleido':
        kaleido(ctx, p, t - fx.start, k);
        break;
      case 'tile':
        tile(ctx, p, t - fx.start, k);
        break;
      case 'burst':
        burst(ctx, p, t, k, fx.color ?? '#ffffff');
        break;
      case 'glass':
        glass(ctx, p, fx.start, k);
        break;
      case 'flash':
        ctx.globalAlpha = Math.min(1, (p.alpha ?? 0.9) * k);
        ctx.fillStyle = fx.color ?? '#ffffff';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        break;
      case 'grade':
        grade(ctx, p, k, fx.color);
        break;
    }
    ctx.restore();
  }
}

function mirror(ctx: Ctx2D, mode: number, k: number) {
  const { width: W, height: H } = ctx.canvas;
  const src = copyOf(ctx);
  ctx.globalAlpha = k;
  if (mode === 0 || mode === 2) {
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0, W / 2, H, 0, 0, W / 2, H);
    ctx.restore();
  }
  if (mode === 1 || mode === 2) {
    const src2 = mode === 2 ? copyOf(ctx) : src;
    ctx.translate(0, H);
    ctx.scale(1, -1);
    ctx.drawImage(src2, 0, 0, W, H / 2, 0, 0, W, H / 2);
  }
}

function kaleido(ctx: Ctx2D, p: Record<string, number>, age: number, k: number) {
  const { width: W, height: H } = ctx.canvas;
  const src = copyOf(ctx);
  const n = Math.max(2, Math.round(p.segments / 2) * 2);
  const wedge = (2 * Math.PI) / n;
  const R = Math.hypot(W, H);
  const spin = ((p.spin ?? 0) * Math.PI * age) / 180;
  ctx.globalAlpha = k;
  ctx.translate(W / 2, H / 2);
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.rotate(i * wedge + spin);
    if (i % 2) ctx.scale(1, -1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -0.001, wedge + 0.001);
    ctx.closePath();
    ctx.clip();
    ctx.scale(p.zoom ?? 1, p.zoom ?? 1);
    ctx.drawImage(src, -W / 2, -H / 2);
    ctx.restore();
  }
}

function tile(ctx: Ctx2D, p: Record<string, number>, age: number, k: number) {
  const { width: W, height: H } = ctx.canvas;
  const src = copyOf(ctx);
  const n = Math.max(1, Math.round(p.n));
  const spin = ((p.spin ?? 0) * Math.PI * age) / 180;
  const z = p.zoom ?? 1;
  ctx.globalAlpha = k;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(spin);
  ctx.scale(z, z);
  const w = W / n;
  const h = H / n;
  const extra = spin ? 2 : 0; // cover the corners while rotating
  for (let i = -extra; i < n + extra; i++)
    for (let j = -extra; j < n + extra; j++) {
      ctx.save();
      ctx.translate(-W / 2 + i * w + w / 2, -H / 2 + j * h + h / 2);
      ctx.scale(((i % 2) + 2) % 2 ? -1 : 1, ((j % 2) + 2) % 2 ? -1 : 1);
      ctx.drawImage(src, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
}

/** Radial speed lines: thin wedges from outside towards the centre, flickering ~15×/s. */
function burst(ctx: Ctx2D, p: Record<string, number>, t: number, k: number, color: string) {
  const { width: W, height: H } = ctx.canvas;
  const R = Math.hypot(W, H) / 2;
  const r0 = (p.inner ?? 0.3) * Math.min(W, H) * 0.5;
  const seed = Math.floor(t * 15);
  ctx.translate(W / 2, H / 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = Math.min(1, (p.alpha ?? 0.85) * k);
  const count = Math.round(p.count ?? 48);
  for (let i = 0; i < count; i++) {
    const a = hash01(seed * 131 + i * 7.13) * Math.PI * 2;
    const width = (0.004 + 0.016 * hash01(seed * 17 + i * 3.7)) * Math.PI;
    const start = r0 * (0.8 + 0.7 * hash01(seed * 5 + i * 11.1));
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * start, Math.sin(a) * start);
    ctx.lineTo(Math.cos(a - width) * R, Math.sin(a - width) * R);
    ctx.lineTo(Math.cos(a + width) * R, Math.sin(a + width) * R);
    ctx.closePath();
    ctx.fill();
  }
}

/** Shattered-glass rays: jagged white lines from the centre (fixed per effect). */
function glass(ctx: Ctx2D, p: Record<string, number>, seedT: number, k: number) {
  const { width: W, height: H } = ctx.canvas;
  const R = Math.hypot(W, H) / 2;
  ctx.translate(W / 2, H / 2);
  ctx.globalAlpha = Math.min(1, (p.alpha ?? 0.9) * k);
  ctx.strokeStyle = '#ffffff';
  ctx.lineJoin = 'miter';
  const count = Math.round(p.count ?? 9);
  for (let i = 0; i < count; i++) {
    const a = ((i + hash01(seedT * 3 + i) * 0.6) / count) * Math.PI * 2;
    ctx.lineWidth = Math.max(1.5, H * (0.003 + 0.004 * hash01(seedT + i * 9)));
    ctx.beginPath();
    let r = 0;
    ctx.moveTo(0, 0);
    while (r < R) {
      r += R * (0.12 + 0.2 * hash01(seedT * 7 + i * 13 + r));
      const jit = (hash01(seedT + i * 31 + r) - 0.5) * 0.12;
      ctx.lineTo(Math.cos(a + jit) * r, Math.sin(a + jit) * r);
    }
    ctx.stroke();
  }
}

function grade(ctx: Ctx2D, p: Record<string, number>, k: number, tintColor?: string) {
  const { width: W, height: H } = ctx.canvas;
  const src = copyOf(ctx);
  const mix = (v: number, base: number) => base + (v - base) * k;
  ctx.filter = `saturate(${mix(p.saturate ?? 1, 1)}) contrast(${mix(p.contrast ?? 1, 1)}) brightness(${mix(p.brightness ?? 1, 1)}) hue-rotate(${(p.hue ?? 0) * k}deg)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  if (tintColor && (p.tint ?? 0) > 0) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = Math.min(1, p.tint * k);
    ctx.fillStyle = tintColor;
    ctx.fillRect(0, 0, W, H);
  }
}
