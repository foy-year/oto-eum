import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Num, Pick, Row, Section, fmt } from './widgets';
import { sceneRects, videoTracksOf } from '../core/video/timeline';
import { type Rect, type VideoScene, uid } from '../core/types';

const LAYOUTS: { value: VideoScene['layout']; label: string }[] = [
  { value: 'grid', label: 'grid' },
  { value: 'focus', label: 'focus (1st big + others)' },
  { value: 'columns', label: 'columns' },
  { value: 'rows', label: 'rows' },
  { value: 'single', label: 'single (full screen, newest on top)' },
  { value: 'custom', label: 'custom (drag boxes)' },
];
const COLORS = ['#5ad1b3', '#ff7a9c', '#ffcc4d', '#7aa2ff', '#c58bff', '#ff9f43', '#4dd2ff', '#a3e635'];
const snap = (v: number) => Math.round(v * 24) / 24;

/** Drag/resize boxes for a custom layout (16:9 canvas). */
function RectEditor({ scene, names, onChange }: { scene: VideoScene; names: Record<string, string>; onChange: (rects: Record<string, Rect>) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rects = sceneRects(scene);
  const drag = useRef<{ id: string; mode: 'move' | 'size'; x: number; y: number; r: Rect } | null>(null);
  useEffect(() => {
    const c = ref.current!;
    const W = (c.width = c.clientWidth * devicePixelRatio);
    const H = (c.height = (c.clientWidth * 9) / 16 * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b0d14';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1d2230';
    for (let i = 1; i < 12; i++) {
      g.beginPath();
      g.moveTo((i * W) / 12, 0);
      g.lineTo((i * W) / 12, H);
      g.moveTo(0, (i * H) / 12);
      g.lineTo(W, (i * H) / 12);
      g.stroke();
    }
    scene.order.forEach((id, i) => {
      const r = rects[id];
      if (!r) return;
      g.fillStyle = COLORS[i % COLORS.length] + '55';
      g.strokeStyle = COLORS[i % COLORS.length];
      g.lineWidth = 2;
      g.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
      g.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
      g.fillStyle = '#fff';
      g.font = `${12 * devicePixelRatio}px sans-serif`;
      g.fillText(`${i + 1}. ${names[id] ?? id}`, r.x * W + 6, r.y * H + 16 * devicePixelRatio);
      g.fillRect((r.x + r.w) * W - 8, (r.y + r.h) * H - 8, 8, 8);
    });
  });
  const at = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height, b };
  };
  return (
    <canvas
      ref={ref}
      className="scene-canvas"
      onPointerDown={(e) => {
        const p = at(e);
        // topmost (last drawn) box under the pointer
        for (const id of [...scene.order].reverse()) {
          const r = rects[id];
          if (!r || p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
          const nearCorner = (r.x + r.w - p.x) * p.b.width < 14 && (r.y + r.h - p.y) * p.b.height < 14;
          drag.current = { id, mode: nearCorner ? 'size' : 'move', x: p.x, y: p.y, r };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          break;
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = at(e);
        const dx = p.x - d.x;
        const dy = p.y - d.y;
        const r =
          d.mode === 'move'
            ? { ...d.r, x: snap(Math.min(1 - d.r.w, Math.max(0, d.r.x + dx))), y: snap(Math.min(1 - d.r.h, Math.max(0, d.r.y + dy))) }
            : { ...d.r, w: snap(Math.max(1 / 24, Math.min(1 - d.r.x, d.r.w + dx))), h: snap(Math.max(1 / 24, Math.min(1 - d.r.y, d.r.h + dy))) };
        onChange({ ...rects, [d.id]: r });
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

/** Layout changes over time for the Video Synchronizer. */
export function ScenesEditor({ now }: { now: number }) {
  const { project, assets, update } = useStore();
  const vtracks = videoTracksOf({ tracks: project.tracks, samples: project.samples, assets, trackIds: project.videoTrackIds });
  const names = Object.fromEntries(vtracks.map((t) => [t.id, t.name]));
  const scenes = (project.videoScenes ?? []).slice().sort((a, b) => a.from - b.from);
  const [selId, setSelId] = useState<string>();
  const sel = scenes.find((s) => s.id === selId) ?? scenes[0];
  const setScenes = (fn: (s: VideoScene[]) => VideoScene[]) => update((p) => void (p.videoScenes = fn(p.videoScenes ?? [])));
  const patch = (id: string, ch: Partial<VideoScene>) => setScenes((ss) => ss.map((s) => (s.id === id ? { ...s, ...ch } : s)));
  const activeAt = (t: number) => [...scenes].reverse().find((s) => s.from <= t + 1e-6) ?? scenes[0];

  const addScene = () => {
    const base = scenes.length ? activeAt(now) : null;
    const s: VideoScene = base
      ? { ...structuredClone(base), id: uid('sc'), from: Math.round(now * 1000) / 1000 }
      : { id: uid('sc'), from: 0, layout: project.videoSync.layout, order: vtracks.map((t) => t.id) };
    setScenes((ss) => [...ss, s]);
    setSelId(s.id);
  };

  return (
    <Section
      title={`Scenes (${scenes.length || 'one layout'})`}
      actions={
        <>
          <button onClick={addScene} disabled={!vtracks.length}>
            + Scene at {fmt(scenes.length ? now : 0)}
          </button>
          {scenes.length > 0 && (
            <button className="danger" onClick={() => confirm('Remove all scenes (back to one layout)?') && update((p) => void (p.videoScenes = []))}>
              Clear
            </button>
          )}
        </>
      }
    >
      {!scenes.length && <p className="hint">The whole video uses the layout above. Add scenes to change the layout over time (e.g. 2 tracks in the intro, all tracks in the chorus).</p>}
      {scenes.length > 0 && (
        <table className="list">
          <tbody>
            {scenes.map((s) => (
              <tr key={s.id} className={s.id === sel?.id ? 'sel' : ''} onClick={() => setSelId(s.id)}>
                <td>
                  <Num label="from" value={s.from} step={0.01} unit="s" onChange={(v) => patch(s.id, { from: Math.max(0, v) })} />
                  <button onClick={() => patch(s.id, { from: Math.round(now * 1000) / 1000 })} title="Set to the preview position">
                    ◎ {fmt(now)}
                  </button>
                </td>
                <td>
                  <Pick
                    label=""
                    value={s.layout}
                    options={LAYOUTS}
                    onChange={(v) => patch(s.id, v === 'custom' ? { layout: v, rects: sceneRects(s) } : { layout: v })}
                  />
                </td>
                <td className="hint">{s.order.map((id) => names[id] ?? '?').join(', ') || 'nothing visible'}</td>
                <td className="actions">
                  <button className="danger" onClick={() => setScenes((ss) => ss.filter((x) => x.id !== s.id))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel && (
        <div className="fx">
          <header>
            <b>Scene from {fmt(sel.from)}</b>
            <span className="hint">Tick the tracks to show; order sets the position (1 = focus / top-left).</span>
          </header>
          <Row>
            {vtracks.map((t) => {
              const i = sel.order.indexOf(t.id);
              return (
                <span key={t.id} className={`chip ${i >= 0 ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={i >= 0}
                    onChange={(e) => patch(sel.id, { order: e.target.checked ? [...sel.order, t.id] : sel.order.filter((x) => x !== t.id) })}
                  />
                  {i >= 0 ? `${i + 1}. ` : ''}
                  {t.name}
                  {i > 0 && (
                    <button
                      onClick={() => {
                        const o = sel.order.slice();
                        [o[i - 1], o[i]] = [o[i], o[i - 1]];
                        patch(sel.id, { order: o });
                      }}
                    >
                      ←
                    </button>
                  )}
                </span>
              );
            })}
          </Row>
          {sel.layout === 'custom' ? (
            <>
              <RectEditor scene={sel} names={names} onChange={(rects) => patch(sel.id, { rects })} />
              <p className="hint">Drag a box to move it, drag its corner square to resize (snaps to 1/24 of the screen).</p>
            </>
          ) : (
            <RectPreview scene={sel} names={names} />
          )}
        </div>
      )}
    </Section>
  );
}

function RectPreview({ scene, names }: { scene: VideoScene; names: Record<string, string> }) {
  const rects = sceneRects(scene);
  return (
    <div className="scene-preview">
      {scene.order.map((id, i) => {
        const r = rects[id];
        return r ? (
          <div key={id} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderColor: COLORS[i % COLORS.length] }}>
            {i + 1}. {names[id]}
          </div>
        ) : null;
      })}
    </div>
  );
}
