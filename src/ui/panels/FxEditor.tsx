import { useState } from 'react';
import { useStore } from '../store';
import { Num, Pick, Row, Section, fmt } from '../widgets';
import { type TextOverlay, type VideoFx, type VideoFxKind, uid } from '../../core/types';
import { FX_DEFAULTS } from '../../core/video/fx';

const LABEL: Record<VideoFxKind, string> = {
  mirror: 'Mirror (symmetric halves)',
  kaleido: 'Kaleidoscope',
  tile: 'Tile (mirrored grid)',
  burst: 'Speed lines (集中線)',
  glass: 'Shattered glass',
  flash: 'Flash',
  grade: 'Colour grade',
};
const PARAM_LABEL: Record<string, string> = { mode: 'mode (0 L→R, 1 top→bottom, 2 quad)', segments: 'segments', spin: 'spin °/s', zoom: 'zoom', n: 'copies per side', count: 'lines', inner: 'inner radius', alpha: 'opacity', decay: 'decay s', saturate: 'saturation', contrast: 'contrast', brightness: 'brightness', hue: 'hue °', tint: 'tint amount' };

/** Whole-frame effects timeline + genre presets. */
export function FxEditor({ now }: { now: number }) {
  const { project, update } = useStore();
  const list = (project.videoFx ?? []).slice().sort((a, b) => a.start - b.start);
  const [selId, setSelId] = useState<string>();
  const sel = list.find((f) => f.id === selId);
  const setFx = (fn: (l: VideoFx[]) => VideoFx[]) => update((p) => void (p.videoFx = fn(p.videoFx ?? [])));
  const patch = (id: string, ch: Partial<VideoFx>) => setFx((l) => l.map((f) => (f.id === id ? { ...f, ...ch } : f)));
  const bar = (4 * 60) / project.bpm;
  const add = (kind: VideoFxKind) => {
    const fx: VideoFx = { id: uid('fx'), kind, start: Math.round(now * 100) / 100, end: Math.round((now + (kind === 'flash' ? 0.4 : bar * 2)) * 100) / 100, params: { ...FX_DEFAULTS[kind] }, color: kind === 'grade' ? '#ff9a3c' : '#ffffff' };
    setFx((l) => [...l, fx]);
    setSelId(fx.id);
  };
  /** "YOUKAI ZONE ⟫ 〇〇" style title: flash, speed lines, glass rays and a two-part title. */
  const titleBurst = () => {
    const word = prompt('Title word (e.g. the subject in Japanese)', 'ライフ');
    if (word == null) return;
    const t0 = Math.round(now * 100) / 100;
    const t1 = Math.round((now + bar * 2) * 100) / 100;
    const fx: VideoFx[] = [
      { id: uid('fx'), kind: 'flash', start: t0, end: t0 + 0.5, params: { decay: 0.18, alpha: 0.95 }, color: '#ffffff' },
      { id: uid('fx'), kind: 'burst', start: t0, end: t1, params: { count: 56, inner: 0.34, alpha: 0.8 }, color: '#ffffff' },
      { id: uid('fx'), kind: 'glass', start: t0, end: t1, params: { count: 9, alpha: 0.85 } },
    ];
    const texts: TextOverlay[] = [
      { id: uid('tx'), text: 'YOUKAI\nZONE »', start: t0, end: t1, x: 0.36, y: 0.5, size: 0.085, color: '#ffffff', stroke: '#101522', align: 'right', anim: 'slide', font: 'sans' },
      { id: uid('tx'), text: word, start: t0 + 0.12, end: t1, x: 0.4, y: 0.5, size: 0.2, color: '#e8252e', stroke: '#ffffff', align: 'left', anim: 'pop', font: 'serif' },
    ];
    update((p) => {
      p.videoFx = [...(p.videoFx ?? []), ...fx];
      p.texts = [...(p.texts ?? []), ...texts];
    });
  };
  return (
    <Section
      title={`Video FX (${list.length})`}
      actions={
        <>
          <Pick label="" value={undefined} placeholder={`+ Effect at ${fmt(now)}…`} options={(Object.keys(LABEL) as VideoFxKind[]).map((k) => ({ value: k, label: LABEL[k] }))} onChange={(k) => k && add(k)} />
          <button onClick={titleBurst} title="Flash + speed lines + glass rays + 'YOUKAI ZONE ⟫ word' title, 2 bars">
            + Title burst
          </button>
        </>
      }
    >
      {!list.length && <p className="hint">Mirror, kaleidoscope, tiling, speed lines, shattered glass, flashes and colour grades over time. Effects apply in list order, under the text.</p>}
      <table className="list">
        <tbody>
          {list.map((f) => (
            <tr key={f.id} className={f.id === sel?.id ? 'sel' : ''} onClick={() => setSelId(f.id)}>
              <td>{LABEL[f.kind]}</td>
              <td className="hint">
                {fmt(f.start)} – {fmt(f.end)}
              </td>
              <td className="actions">
                <button className="danger" onClick={() => setFx((l) => l.filter((x) => x.id !== f.id))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && (
        <div className="fx">
          <Row>
            <Num label="Start" value={sel.start} step={0.05} unit="s" onChange={(v) => patch(sel.id, { start: Math.max(0, v) })} />
            <button onClick={() => patch(sel.id, { start: Math.round(now * 100) / 100 })}>◎ {fmt(now)}</button>
            <Num label="End" value={sel.end} step={0.05} unit="s" onChange={(v) => patch(sel.id, { end: v })} />
            <button onClick={() => patch(sel.id, { end: Math.round(now * 100) / 100 })}>◎ {fmt(now)}</button>
            <Num label="Fade" value={sel.fade ?? 0.06} step={0.02} unit="s" onChange={(v) => patch(sel.id, { fade: Math.max(0, v) })} />
            {(sel.kind === 'burst' || sel.kind === 'flash' || sel.kind === 'grade') && (
              <label className="field">
                <span>{sel.kind === 'grade' ? 'Tint' : 'Colour'}</span>
                <input type="color" value={sel.color ?? '#ffffff'} onChange={(e) => patch(sel.id, { color: e.target.value })} />
              </label>
            )}
          </Row>
          <Row>
            {Object.keys(FX_DEFAULTS[sel.kind]).map((k) => (
              <Num key={k} label={PARAM_LABEL[k] ?? k} value={sel.params[k] ?? FX_DEFAULTS[sel.kind][k]} step={k === 'segments' || k === 'n' || k === 'count' || k === 'mode' ? 1 : 0.05} width={70} onChange={(v) => patch(sel.id, { params: { ...sel.params, [k]: v } })} />
            ))}
          </Row>
        </div>
      )}
    </Section>
  );
}
