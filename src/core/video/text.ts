/** Text overlays and title cards (canvas 2D). */
import type { TextOverlay } from '../types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const FONTS: Record<NonNullable<TextOverlay['font']>, string> = {
  sans: '"Noto Sans JP", "Noto Sans KR", "Hiragino Sans", "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif',
  rounded: '"M PLUS Rounded 1c", "Nunito", "Hiragino Maru Gothic ProN", system-ui, sans-serif',
  serif: '"Noto Serif JP", "Noto Serif KR", Georgia, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
};

const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

/** Animation state of an overlay at time t (null = not visible). */
export function textState(o: TextOverlay, t: number): { alpha: number; scale: number; dx: number; chars: number } | null {
  if (t < o.start || t >= o.end) return null;
  const age = t - o.start;
  const left = o.end - t;
  const len = [...o.text].length;
  switch (o.anim ?? 'fade') {
    case 'none':
      return { alpha: 1, scale: 1, dx: 0, chars: len };
    case 'pop': {
      const k = Math.min(1, age / 0.25);
      return { alpha: Math.min(1, age / 0.08, left / 0.15), scale: 0.6 + 0.4 * easeOutBack(k), dx: 0, chars: len };
    }
    case 'type': {
      const dur = Math.min(1.2, (o.end - o.start) * 0.4);
      return { alpha: Math.min(1, left / 0.2), scale: 1, dx: 0, chars: Math.min(len, Math.ceil((age / dur) * len)) };
    }
    case 'slide': {
      const k = Math.min(1, age / 0.3);
      return { alpha: Math.min(1, age / 0.2, left / 0.2), scale: 1, dx: -0.08 * Math.pow(1 - k, 3), chars: len };
    }
    case 'fade':
    default:
      return { alpha: Math.min(1, age / 0.25, left / 0.25), scale: 1, dx: 0, chars: len };
  }
}

export function drawText(ctx: Ctx2D, o: TextOverlay, t: number): void {
  const st = textState(o, t);
  if (!st) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const px = Math.max(6, o.size * H);
  const lines = [...o.text].slice(0, st.chars).join('').split('\n');
  ctx.save();
  ctx.globalAlpha = st.alpha;
  if (o.background === 'card') {
    ctx.fillStyle = o.backgroundColor ?? '#000';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.font = `${o.bold === false ? 400 : 800} ${px}px ${FONTS[o.font ?? 'sans']}`;
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  const lh = px * 1.2;
  const x = (o.x + st.dx) * W;
  const y0 = o.y * H - ((lines.length - 1) * lh) / 2;
  ctx.translate(x, o.y * H);
  ctx.scale(st.scale, st.scale);
  ctx.translate(-x, -o.y * H);
  if (o.background === 'box') {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bx = ctx.textAlign === 'center' ? x - w / 2 : ctx.textAlign === 'right' ? x - w : x;
    ctx.fillStyle = o.backgroundColor ?? 'rgba(0,0,0,.6)';
    ctx.fillRect(bx - px * 0.35, y0 - lh / 2 - px * 0.15, w + px * 0.7, lines.length * lh + px * 0.3);
  }
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    if (o.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, px * 0.14);
      ctx.strokeStyle = o.stroke;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}
