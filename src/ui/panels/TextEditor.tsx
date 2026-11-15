import { useState } from 'react';
import { useStore } from '../store';
import { Num, Pick, Row, Section, fmt } from '../widgets';
import { type TextOverlay, uid } from '../../core/types';

const PRESETS: Record<string, Omit<TextOverlay, 'id' | 'start' | 'end'>> = {
  'Title card': { text: 'Title', x: 0.5, y: 0.45, size: 0.12, color: '#ffffff', background: 'card', backgroundColor: '#0b0d14', anim: 'pop', font: 'rounded' },
  Caption: { text: 'Caption', x: 0.5, y: 0.88, size: 0.065, color: '#ffffff', stroke: '#000000', anim: 'fade' },
  Lyrics: { text: '歌詞', x: 0.5, y: 0.82, size: 0.08, color: '#ffe066', stroke: '#1a1a1a', anim: 'type', font: 'rounded' },
  'Lower third': { text: 'Name / source', x: 0.04, y: 0.86, size: 0.05, color: '#ffffff', align: 'left', background: 'box', backgroundColor: 'rgba(0,0,0,.65)', anim: 'slide' },
  Credits: { text: 'Music: …\nSources: …\nMade with oto-eum', x: 0.5, y: 0.5, size: 0.06, color: '#ffffff', background: 'card', backgroundColor: '#000000', anim: 'fade', bold: false },
};

/** Text overlays & title cards for the Video Editor. */
export function TextEditor({ now }: { now: number }) {
  const { project, update } = useStore();
  const texts = (project.texts ?? []).slice().sort((a, b) => a.start - b.start);
  const [selId, setSelId] = useState<string>();
  const sel = texts.find((t) => t.id === selId);
  const set = (fn: (t: TextOverlay[]) => TextOverlay[]) => update((p) => void (p.texts = fn(p.texts ?? [])));
  const patch = (id: string, ch: Partial<TextOverlay>) => set((ts) => ts.map((t) => (t.id === id ? { ...t, ...ch } : t)));
  const add = (preset: string) => {
    const p = PRESETS[preset];
    const dur = p.background === 'card' ? 2.5 : 2;
    const t: TextOverlay = { ...p, id: uid('tx'), start: Math.round(now * 100) / 100, end: Math.round((now + dur) * 100) / 100 };
    set((ts) => [...ts, t]);
    setSelId(t.id);
  };
  return (
    <Section
      title={`Text & titles (${texts.length})`}
      actions={<Pick label="" value={undefined} placeholder={`+ Add at ${fmt(now)}…`} options={Object.keys(PRESETS).map((k) => ({ value: k, label: k }))} onChange={(k) => k && add(k)} />}
    >
      {!texts.length && <p className="hint">Captions, lyrics, title and credit cards. They are drawn over the video in the preview and the export.</p>}
      <table className="list">
        <tbody>
          {texts.map((t) => (
            <tr key={t.id} className={t.id === sel?.id ? 'sel' : ''} onClick={() => setSelId(t.id)}>
              <td>{t.text.split('\n')[0]}</td>
              <td className="hint">
                {fmt(t.start)} – {fmt(t.end)}
              </td>
              <td className="actions">
                <button className="danger" onClick={() => set((ts) => ts.filter((x) => x.id !== t.id))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && (
        <div className="fx">
          <textarea rows={2} style={{ width: '100%' }} value={sel.text} onChange={(e) => patch(sel.id, { text: e.target.value })} />
          <Row>
            <Num label="Start" value={sel.start} step={0.05} unit="s" onChange={(v) => patch(sel.id, { start: Math.max(0, v) })} />
            <button onClick={() => patch(sel.id, { start: Math.round(now * 100) / 100 })}>◎ {fmt(now)}</button>
            <Num label="End" value={sel.end} step={0.05} unit="s" onChange={(v) => patch(sel.id, { end: v })} />
            <button onClick={() => patch(sel.id, { end: Math.round(now * 100) / 100 })}>◎ {fmt(now)}</button>
            <Pick
              label="Animation"
              value={sel.anim ?? 'fade'}
              options={(['fade', 'pop', 'type', 'slide', 'none'] as const).map((v) => ({ value: v, label: v }))}
              onChange={(v) => patch(sel.id, { anim: v })}
            />
          </Row>
          <Row>
            <Num label="x" value={sel.x} step={0.01} width={60} onChange={(v) => patch(sel.id, { x: v })} />
            <Num label="y" value={sel.y} step={0.01} width={60} onChange={(v) => patch(sel.id, { y: v })} />
            <Num label="Size" value={sel.size} step={0.005} width={60} onChange={(v) => patch(sel.id, { size: Math.max(0.01, v) })} />
            <Pick label="Align" value={sel.align ?? 'center'} options={(['left', 'center', 'right'] as const).map((v) => ({ value: v, label: v }))} onChange={(v) => patch(sel.id, { align: v })} />
            <Pick label="Font" value={sel.font ?? 'sans'} options={(['sans', 'rounded', 'serif', 'mono'] as const).map((v) => ({ value: v, label: v }))} onChange={(v) => patch(sel.id, { font: v })} />
            <label className="field">
              <span>Colour</span>
              <input type="color" value={sel.color} onChange={(e) => patch(sel.id, { color: e.target.value })} />
            </label>
            <label className="field">
              <span>Outline</span>
              <input type="checkbox" checked={!!sel.stroke} onChange={(e) => patch(sel.id, { stroke: e.target.checked ? '#000000' : undefined })} />
              {sel.stroke && <input type="color" value={sel.stroke} onChange={(e) => patch(sel.id, { stroke: e.target.value })} />}
            </label>
            <Pick
              label="Background"
              value={sel.background ?? 'none'}
              options={[
                { value: 'none', label: 'none' },
                { value: 'box', label: 'box' },
                { value: 'card', label: 'full screen (title card)' },
              ]}
              onChange={(v) => patch(sel.id, { background: v })}
            />
            {sel.background && sel.background !== 'none' && (
              <label className="field">
                <span>BG</span>
                <input type="color" value={(sel.backgroundColor ?? '#000000').slice(0, 7)} onChange={(e) => patch(sel.id, { backgroundColor: e.target.value })} />
              </label>
            )}
          </Row>
        </div>
      )}
    </Section>
  );
}
