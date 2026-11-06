import { useEffect, useRef, useState } from 'react';
import { download, job, loadPcm, useStore } from '../store';
import { Check, Num, Pick, Row, Section } from '../widgets';
import type { Note, NoteTrack, Project } from '../../core/types';
import { uid } from '../../core/types';
import { exportMidi, gridSeconds, legato, monophonize, quantize, splitVoices, transpose, setVelocity, mergeRepeats, endTime } from '../../core/midi/midi';
import { midiToName } from '../../core/analysis/pitch';
import { createTrack, createSample } from '../../core/project';
import { renderNoteTrack, renderTrack } from '../../core/render/sampler';
import { createPcm, type Pcm } from '../../core/audio/pcm';
import { play, stop, position, onPlayerChange } from '../player';

const ROW = 12;
const KEYS = 44;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** Render a track with its assigned sample, or a sine "preview synth" if none. */
export async function previewTrackAudio(project: Project, track: NoteTrack): Promise<Pcm> {
  const sample = project.samples.find((s) => s.id === track.sampleId);
  if (sample) return renderNoteTrack(track, sample, await loadPcm(sample.sourceId), { sampleRate: project.sampleRate });
  const sr = project.sampleRate;
  const sine = createPcm(sr, 1, sr);
  for (let i = 0; i < sr; i++) sine.channels[0][i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr);
  return renderTrack(track.notes, sine, createSample('', 0, 1, { rootPitch: 69, sustain: 'loop', release: 0.02 }), { sampleRate: sr });
}

type Drag = { kind: 'move' | 'resize'; ids: string[]; t0: number; p0: number; orig: Note[] } | null;

export function MidiEditor() {
  const { project, selectedTrackId, select, updateTrack, addTrack, removeTrack, update } = useStore();
  const track = project.tracks.find((t) => t.id === selectedTrackId) ?? project.tracks[0];
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(120); // pixels per second
  const [scrollX, setScrollX] = useState(0); // seconds
  const [topPitch, setTopPitch] = useState(84);
  const [division, setDivision] = useState(16);
  const [snap, setSnap] = useState(true);
  const [ghosts, setGhosts] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const drag = useRef<Drag>(null);
  const [, tick] = useState(0);

  const grid = gridSeconds(project.bpm, division);
  const snapT = (t: number) => (snap ? Math.round(t / grid) * grid : t);
  const setNotes = (notes: Note[]) => track && updateTrack(track.id, { notes });

  // playhead animation
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      tick((x) => x + 1);
      if (position() != null) raf = requestAnimationFrame(loop);
    };
    const off = onPlayerChange(() => {
      cancelAnimationFrame(raf);
      loop();
    });
    return () => (off(), cancelAnimationFrame(raf));
  }, []);

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = devicePixelRatio;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const rows = Math.ceil(H / ROW);
    const x = (t: number) => KEYS + (t - scrollX) * pps;
    const y = (p: number) => (topPitch - p) * ROW;
    for (let r = 0; r <= rows; r++) {
      const p = topPitch - r;
      g.fillStyle = BLACK.has(((p % 12) + 12) % 12) ? '#181b24' : '#1f2330';
      g.fillRect(KEYS, r * ROW, W, ROW);
      g.fillStyle = BLACK.has(((p % 12) + 12) % 12) ? '#222' : '#ddd';
      g.fillRect(0, r * ROW, KEYS - 2, ROW - 1);
      if (p % 12 === 0) {
        g.fillStyle = '#555';
        g.font = '9px sans-serif';
        g.fillText(midiToName(p), 2, r * ROW + 10);
        g.fillStyle = '#2e3445';
        g.fillRect(KEYS, r * ROW + ROW - 1, W, 1);
      }
    }
    // grid
    const beat = 60 / project.bpm;
    for (let t = Math.floor(scrollX / grid) * grid; x(t) < W; t += grid) {
      const isBar = Math.abs(t / (beat * 4) - Math.round(t / (beat * 4))) < 1e-6;
      const isBeat = Math.abs(t / beat - Math.round(t / beat)) < 1e-6;
      g.fillStyle = isBar ? '#4a5270' : isBeat ? '#33394d' : '#262b3a';
      g.fillRect(x(t), 0, 1, H);
    }
    // ghost notes of other tracks
    if (ghosts)
      for (const t of project.tracks)
        if (t.id !== track?.id)
          for (const n of t.notes) {
            g.fillStyle = 'rgba(160,160,200,.18)';
            g.fillRect(x(n.start), y(n.pitch), n.duration * pps, ROW - 1);
          }
    for (const n of track?.notes ?? []) {
      const s = sel.has(n.id);
      g.fillStyle = s ? '#ffcc4d' : `hsl(${160 + n.pitch * 2}, 60%, ${35 + n.velocity * 30}%)`;
      g.fillRect(x(n.start), y(n.pitch) + 1, Math.max(2, n.duration * pps - 1), ROW - 2);
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(x(n.start + n.duration) - 3, y(n.pitch) + 1, 2, ROW - 2);
    }
    const pos = position();
    if (pos != null) {
      g.fillStyle = '#fff';
      g.fillRect(x(pos), 0, 2, H);
    }
  });

  const hit = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const t = scrollX + (px - KEYS) / pps;
    const pitch = topPitch - Math.floor(py / ROW);
    const note = track?.notes.find((n) => n.pitch === pitch && t >= n.start && t <= n.start + n.duration);
    const nearEnd = note ? (note.start + note.duration - t) * pps < 6 : false;
    return { t, pitch, note, nearEnd, px };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!track) return;
    const h = hit(e);
    if (h.px < KEYS) {
      // click on keyboard → audition pitch
      void previewTrackAudio(project, { ...track, notes: [{ id: 'k', pitch: h.pitch, start: 0, duration: 0.4, velocity: 1 }] }).then((p) => play(p));
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    let ids: string[];
    if (h.note) {
      const next = new Set(e.shiftKey ? sel : sel.has(h.note.id) ? sel : []);
      next.add(h.note.id);
      setSel(next);
      ids = [...next];
    } else {
      const n: Note = { id: uid('n'), pitch: h.pitch, start: Math.max(0, snap ? Math.floor(h.t / grid) * grid : h.t), duration: grid, velocity: 0.8 };
      setNotes([...track.notes, n]);
      setSel(new Set([n.id]));
      ids = [n.id];
      drag.current = { kind: 'resize', ids, t0: h.t, p0: h.pitch, orig: [n] };
      return;
    }
    drag.current = { kind: h.nearEnd ? 'resize' : 'move', ids, t0: h.t, p0: h.pitch, orig: track.notes.filter((n) => ids.includes(n.id)) };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !track) {
      if (canvas.current && track) canvas.current.style.cursor = hit(e).nearEnd ? 'ew-resize' : 'default';
      return;
    }
    const h = hit(e);
    const dt = h.t - d.t0;
    const dp = h.pitch - d.p0;
    const changed = new Map(
      d.orig.map((o) => [
        o.id,
        d.kind === 'move'
          ? { ...o, start: Math.max(0, snapT(o.start + dt)), pitch: Math.max(0, Math.min(127, o.pitch + dp)) }
          : { ...o, duration: Math.max(grid / 4, snapT(o.start + o.duration + dt) - o.start) },
      ]),
    );
    const base = track.notes.filter((n) => !changed.has(n.id));
    setNotes([...base, ...changed.values()]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!track) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      setNotes(track.notes.filter((n) => !sel.has(n.id)));
      setSel(new Set());
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSel(new Set(track.notes.map((n) => n.id)));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      setNotes(track.notes.map((n) => (sel.has(n.id) ? { ...n, pitch: n.pitch + d } : n)));
    } else if (e.key === ' ') {
      e.preventDefault();
      if (position() != null) stop();
      else void previewTrackAudio(project, track).then((p) => play(p, scrollX));
    }
  };

  const applyOp = (fn: (n: Note[]) => Note[]) => {
    if (!track) return;
    const target = sel.size ? track.notes.filter((n) => sel.has(n.id)) : track.notes;
    const rest = sel.size ? track.notes.filter((n) => !sel.has(n.id)) : [];
    const out = fn(target);
    setNotes([...rest, ...out]);
    if (sel.size) setSel(new Set(out.map((n) => n.id)));
  };

  return (
    <div className="panel">
      <Section
        title="MIDI editor"
        actions={
          <>
            <Pick label="Track" value={track?.id} options={project.tracks.map((t) => ({ value: t.id, label: `${t.name} (${t.notes.length})` }))} onChange={(id) => select({ selectedTrackId: id })} />
            <button onClick={() => addTrack(createTrack(`Track ${project.tracks.length + 1}`))}>+ New track</button>
            {track && (
              <button className="danger" onClick={() => confirm(`Delete ${track.name}?`) && removeTrack(track.id)}>
                Delete track
              </button>
            )}
          </>
        }
      >
        {!track ? (
          <div className="empty">No tracks yet — extract MIDI, import a .mid, or create a new track.</div>
        ) : (
          <>
            <Row>
              <label className="field">
                <span>Name</span>
                <input value={track.name} onChange={(e) => updateTrack(track.id, { name: e.target.value })} />
              </label>
              <Num label="BPM" value={project.bpm} step={1} onChange={(v) => update((p) => void (p.bpm = Math.max(20, v)))} />
              <Pick label="Grid" value={String(division)} options={[4, 8, 12, 16, 24, 32, 64].map((d) => ({ value: String(d), label: `1/${d}` }))} onChange={(v) => setDivision(+v)} />
              <Check label="Snap" value={snap} onChange={setSnap} />
              <Check label="Ghost other tracks" value={ghosts} onChange={setGhosts} />
              <Num label="Zoom" value={pps} step={10} unit="px/s" onChange={(v) => setPps(Math.max(10, Math.min(2000, v)))} />
            </Row>
            <Row>
              <button onClick={() => void job('Rendering…', async () => play(await previewTrackAudio(project, track), scrollX))}>▶ Play (space)</button>
              <button onClick={stop}>■ Stop</button>
              <span className="sep" />
              <span className="hint">{sel.size ? `${sel.size} selected →` : 'All notes →'}</span>
              <button onClick={() => applyOp((n) => quantize(n, project.bpm, division))}>Quantize</button>
              <button onClick={() => applyOp((n) => quantize(n, project.bpm, division, { strength: 0.5 }))}>Quantize 50%</button>
              <button onClick={() => applyOp((n) => transpose(n, 1))}>+1</button>
              <button onClick={() => applyOp((n) => transpose(n, -1))}>−1</button>
              <button onClick={() => applyOp((n) => transpose(n, 12))}>+8va</button>
              <button onClick={() => applyOp((n) => transpose(n, -12))}>−8va</button>
              <button onClick={() => applyOp((n) => legato(n))}>Legato</button>
              <button onClick={() => applyOp((n) => monophonize(n))}>Monophonize</button>
              <button onClick={() => applyOp((n) => mergeRepeats(n, 0.03))}>Merge repeats</button>
              <button onClick={() => applyOp((n) => setVelocity(n, 1))}>Vel 100%</button>
              <button
                onClick={() => {
                  const voices = splitVoices(track.notes, 4);
                  if (voices.length < 2) return alert('Track is already monophonic.');
                  voices.forEach((v, i) => addTrack(createTrack(`${track.name} v${i + 1}`, { notes: v, sampleId: track.sampleId })));
                }}
              >
                Split voices → tracks
              </button>
            </Row>
            <canvas
              ref={canvas}
              className="pianoroll"
              tabIndex={0}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={() => (drag.current = null)}
              onDoubleClick={(e) => {
                const h = hit(e);
                if (h.note) setNotes(track.notes.filter((n) => n.id !== h.note!.id));
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const h = hit(e);
                if (h.note) setNotes(track.notes.filter((n) => n.id !== h.note!.id));
              }}
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) setPps((v) => Math.max(10, Math.min(2000, v * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
                else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) setScrollX((s) => Math.max(0, s + (e.deltaX || e.deltaY) / pps));
                else setTopPitch((p) => Math.max(20, Math.min(127, p - Math.sign(e.deltaY) * 2)));
              }}
              onKeyDown={onKey}
            />
            <input
              type="range"
              className="hscroll"
              min={0}
              max={Math.max(1, endTime(project.tracks))}
              step={0.01}
              value={scrollX}
              onChange={(e) => setScrollX(+e.target.value)}
            />
            <p className="hint">
              Click empty space to draw · drag to move · drag the right edge to resize · double/right-click to delete · Shift-click multi-select · ↑/↓ transpose (Shift = octave) · Del delete · Ctrl+A select all · wheel scroll pitch, Shift+wheel time, Ctrl+wheel zoom · click keys to audition.
            </p>
          </>
        )}
      </Section>
      <Section title="Export">
        <Row>
          <button disabled={!track} onClick={() => track && download(exportMidi([track], project.bpm, track.name), `${track.name}.mid`, 'audio/midi')}>
            Export this track (.mid)
          </button>
          <button disabled={!project.tracks.length} onClick={() => download(exportMidi(project.tracks, project.bpm, project.name), `${project.name}.mid`, 'audio/midi')}>
            Export all tracks (.mid)
          </button>
        </Row>
      </Section>
    </div>
  );
}
