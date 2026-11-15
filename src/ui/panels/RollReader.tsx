import { useEffect, useRef, useState } from 'react';
import { job, loadPcm, media, useStore } from '../store';
import { Check, Num, Pick, Pitch, Row, Section } from '../widgets';
import { openVideoPixels, type VideoPixels } from '../../core/video/frameStream';
import {
  RollScanner,
  detectRowGridConsensus,
  extractNotes,
  median3,
  notesFromPages,
  suggestTrackHues,
  hueName,
  type HueCluster,
  type PianoRollConfig,
  type Rect4,
  type RgbFrame,
} from '../../core/analysis/pianoRoll';
import { alignNotesToAudio } from '../../core/analysis/align';
import { midiToName } from '../../core/analysis/pitch';
import { estimateGrid } from '../../core/midi/midi';
import { createTrack } from '../../core/project';

interface TrackRow extends HueCluster {
  name: string;
  use: boolean;
}

interface Calib {
  roi: Rect4 | null;
  semitonePx: number;
  rowY: number;
  rowPitch: number;
  tracks: TrackRow[];
}

const hsl = (r: TrackRow) => `rgb(${r.rgb.join(',')})`;
const key = (id: string) => `oto-eum:roll:${id}`;

/** MIDI from a piano-roll ("MIDI video") recording: calibrate on one frame, read the whole video. */
export function RollReader() {
  const { assets, update, setTab } = useStore();
  const videos = assets.filter((a) => a.kind === 'video');
  const [assetId, setAssetId] = useState<string>();
  const asset = videos.find((v) => v.id === assetId) ?? videos[0];
  const [vp, setVp] = useState<VideoPixels | null>(null);
  const [t, setT] = useState(0);
  const [frame, setFrame] = useState<RgbFrame | null>(null);
  const [cal, setCal] = useState<Calib>({ roi: null, semitonePx: 5, rowY: 0, rowPitch: 72, tracks: [] });
  const [fps, setFps] = useState(30);
  const [verify, setVerify] = useState(true);
  const [setTempo, setSetTempo] = useState(true);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // open video + restore calibration
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    let opened: VideoPixels | null = null;
    void job('Opening video…', async () => {
      opened = await openVideoPixels(await media.getBlob(asset.id), 640);
      if (!alive) return opened.dispose();
      setVp(opened);
      setT(Math.min(opened.duration / 2, 10));
      try {
        const saved = localStorage.getItem(key(asset.id));
        setCal(saved ? JSON.parse(saved) : { roi: { x0: Math.round(opened.width * 0.12), x1: opened.width - 4, y0: Math.round(opened.height * 0.12), y1: opened.height - 12 }, semitonePx: 5, rowY: opened.height / 2, rowPitch: 72, tracks: [] });
      } catch {
        /* ignore */
      }
    });
    return () => {
      alive = false;
      opened?.dispose();
    };
  }, [asset?.id]);

  useEffect(() => {
    if (asset && cal.roi) {
      try {
        localStorage.setItem(key(asset.id), JSON.stringify(cal));
      } catch {
        /* ignore */
      }
    }
  }, [cal]);

  useEffect(() => {
    if (!vp) return;
    let alive = true;
    void vp.frameAt(t).then((f) => alive && setFrame(f));
    return () => {
      alive = false;
    };
  }, [vp, t]);

  const cfg = (): PianoRollConfig | null =>
    cal.roi
      ? {
          roi: cal.roi,
          pitchRef: { y: cal.rowY, pitch: cal.rowPitch },
          semitonePx: cal.semitonePx,
          tracks: cal.tracks.filter((r) => r.use).map((r) => ({ name: r.name, hueFrom: r.hueFrom, hueTo: r.hueTo })),
        }
      : null;

  // draw frame + overlays
  useEffect(() => {
    const c = canvas.current;
    if (!c || !frame) return;
    c.width = frame.width;
    c.height = frame.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(frame.width, frame.height);
    if (frame.channels === 4) img.data.set(frame.data);
    else for (let i = 0, j = 0; i < frame.data.length; i += 3, j += 4) img.data.set([frame.data[i], frame.data[i + 1], frame.data[i + 2], 255], j);
    g.putImageData(img, 0, 0);
    const r = cal.roi;
    if (!r) return;
    g.strokeStyle = '#ff2d7a';
    g.lineWidth = 1.5;
    g.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
    // C rows
    g.font = '10px sans-serif';
    for (let k = -200; k < 200; k++) {
      const y = cal.rowY + k * cal.semitonePx;
      if (y < r.y0 || y > r.y1) continue;
      const pitch = cal.rowPitch - k;
      if (((pitch % 12) + 12) % 12 === 0) {
        g.fillStyle = 'rgba(255,45,122,.9)';
        g.fillRect(r.x0 - 26, y - 0.5, 24, 1);
        g.fillText(midiToName(pitch), r.x0 - 26, y - 2);
      }
    }
    const c2 = cfg();
    if (c2 && c2.tracks.length) {
      const used = cal.tracks.filter((x) => x.use);
      for (const n of extractNotes(frame, c2)) {
        const y = cal.rowY - (n.pitch - cal.rowPitch) * cal.semitonePx;
        g.strokeStyle = hsl(used[n.track]);
        g.lineWidth = 2;
        g.strokeRect(n.x0, y - cal.semitonePx / 2, n.x1 - n.x0, cal.semitonePx);
        g.strokeStyle = '#000';
        g.lineWidth = 0.5;
        g.strokeRect(n.x0, y - cal.semitonePx / 2, n.x1 - n.x0, cal.semitonePx);
      }
    }
  }, [frame, cal]);

  const pos = (e: React.PointerEvent) => {
    const b = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * canvas.current!.width, y: ((e.clientY - b.top) / b.height) * canvas.current!.height };
  };

  const autodetect = () =>
    job('Detecting grid and track colours…', async () => {
      if (!vp || !cal.roi) return;
      const samples: RgbFrame[] = [];
      for (let q = 0.06; q < 0.97; q += 0.08) {
        const f = await vp.frameAt(vp.duration * q);
        if (f) samples.push(f);
      }
      const grid = detectRowGridConsensus(samples, cal.roi);
      const hues = suggestTrackHues(samples, cal.roi);
      setCal((c) => {
        const next = { ...c, tracks: hues.map((h, i) => ({ ...h, name: c.tracks[i]?.name ?? `${hueName(((h.hueFrom + ((h.hueTo - h.hueFrom + 360) % 360) / 2) % 360))} track`, use: !h.likelyGrid })) };
        if (grid) {
          next.semitonePx = Math.round(grid.semitonePx * 1000) / 1000;
          // pick the row nearest the middle; name it from the key shading, octave around C4–C5
          const mid = (cal.roi!.y0 + cal.roi!.y1) / 2;
          const k = Math.round((mid - grid.rowCenterY) / grid.semitonePx);
          next.rowY = grid.rowCenterY + k * grid.semitonePx;
          if (grid.pitchClass != null) {
            const pc = (((grid.pitchClass - k) % 12) + 12) % 12;
            next.rowPitch = 60 + pc;
          }
        }
        return next;
      });
      setReport(
        grid
          ? `Grid: ${grid.semitonePx.toFixed(2)} px/semitone${grid.pitchClass != null ? `, key shading matched (${(grid.keyPatternMatch * 100).toFixed(0)}%) — note names set; the octave is checked against the audio when reading` : ' — no key shading found: click a row whose pitch you know and type its note'}. ${hues.length} colours found.`
          : 'Could not detect the row grid — set the semitone height and click a known row.',
      );
    });

  const read = () =>
    job('Reading piano-roll video…', async () => {
      const c = cfg();
      if (!vp || !c || !asset) return;
      if (!c.tracks.length) throw new Error('Select at least one track colour.');
      const sc = new RollScanner(c, fps);
      const total = Math.floor(vp.duration * fps);
      for await (const f of vp.frames(fps)) {
        sc.push(f);
        if (f.index % 30 === 0) {
          setProgress(f.index / total);
          await new Promise((r) => setTimeout(r));
        }
      }
      const { pages, picks } = sc.finish();
      if (!pages.length) throw new Error('No playhead movement found — is this a scrolling/paging piano-roll video with a visible playhead?');
      const comps: RgbFrame[] = [];
      for (const [a, b, d] of picks) {
        const [fa, fb, fd] = await Promise.all([a, b, d].map((i) => vp.frameAt(i / fps + 0.0005)));
        comps.push(median3(fa!, fb!, fd!));
      }
      const res = notesFromPages(pages, comps, c);
      let msg = `${pages.length} pages, ${res.tracks.reduce((s, x) => s + x.notes.length, 0)} notes in ${res.tracks.length} tracks.`;
      let tracks = res.tracks;
      if (verify) {
        const audio = await loadPcm(asset.id).catch(() => null);
        if (audio) {
          const al = alignNotesToAudio(tracks.flatMap((x) => x.notes), audio);
          if (al.shift) tracks = tracks.map((x) => ({ ...x, notes: x.notes.map((n) => ({ ...n, pitch: n.pitch + al.shift })) }));
          msg += ` Audio check: ${al.shift ? `corrected by ${al.shift > 0 ? '+' : ''}${al.shift} semitones` : 'pitches confirmed'} (agreement ${(al.agreement * 100).toFixed(0)}%).`;
          if (al.shift) setCal((cc) => ({ ...cc, rowPitch: cc.rowPitch + al.shift }));
        } else msg += ' (no audio to verify against)';
      }
      const grid = estimateGrid(tracks.flatMap((x) => x.notes));
      if (grid) msg += ` Tempo ≈ ${grid.bpm.toFixed(1)} BPM.`;
      update((p) => {
        if (setTempo && grid) {
          p.bpm = Math.round(grid.bpm * 100) / 100;
          p.gridOffset = Math.round(grid.offset * 1000) / 1000;
        }
        for (const x of tracks) p.tracks.push(createTrack(x.name, { notes: x.notes }));
      });
      setProgress(0);
      setReport(msg);
    });

  if (!videos.length) return null;
  return (
    <Section
      title="From a piano-roll (MIDI) video"
      actions={<Pick label="" value={asset?.id} options={videos.map((v) => ({ value: v.id, label: v.name }))} onChange={setAssetId} />}
    >
      <p className="hint">
        For screen recordings of a piano-roll editor (Domino, FL Studio, Cubase…): one colour per track and a moving playhead. 1) Drag a box around the
        note area (not the keyboard or rulers). 2) Auto-detect. 3) Check the coloured boxes sit on the notes, then Read.
      </p>
      <canvas
        ref={canvas}
        className="roll-canvas"
        onPointerDown={(e) => {
          const p = pos(e);
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (e.shiftKey && cal.roi) {
            // shift-click: this row is the reference row
            const k = Math.round((p.y - cal.rowY) / cal.semitonePx);
            setCal((c) => ({ ...c, rowY: c.rowY + k * c.semitonePx, rowPitch: c.rowPitch - k }));
            return;
          }
          drag.current = p;
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = pos(e);
          const d = drag.current;
          setCal((c) => ({ ...c, roi: { x0: Math.round(Math.min(d.x, p.x)), x1: Math.round(Math.max(d.x, p.x)), y0: Math.round(Math.min(d.y, p.y)), y1: Math.round(Math.max(d.y, p.y)) } }));
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <input type="range" className="hscroll" min={0} max={vp?.duration ?? 1} step={0.05} value={t} onChange={(e) => setT(+e.target.value)} />
      <Row>
        <button className="primary" disabled={!vp || !cal.roi} onClick={autodetect}>
          Auto-detect grid &amp; colours
        </button>
        <Num label="Semitone height" value={cal.semitonePx} step={0.01} unit="px" onChange={(v) => setCal((c) => ({ ...c, semitonePx: Math.max(1, v) }))} />
        <Num label="Reference row y" value={cal.rowY} step={0.5} onChange={(v) => setCal((c) => ({ ...c, rowY: v }))} />
        <Pitch label="is note" value={cal.rowPitch} onChange={(v) => setCal((c) => ({ ...c, rowPitch: v }))} />
        <button onClick={() => setCal((c) => ({ ...c, rowPitch: c.rowPitch + 12 }))}>octave +</button>
        <button onClick={() => setCal((c) => ({ ...c, rowPitch: c.rowPitch - 12 }))}>octave −</button>
        <span className="hint">Shift-click a row on the frame to make it the reference row.</span>
      </Row>
      {cal.tracks.length > 0 && (
        <table className="list">
          <tbody>
            {cal.tracks.map((r, i) => (
              <tr key={i}>
                <td>
                  <span className="swatch" style={{ background: hsl(r) }} />
                </td>
                <td>
                  <Check label="" value={r.use} onChange={(v) => setCal((c) => ({ ...c, tracks: c.tracks.map((x, j) => (j === i ? { ...x, use: v } : x)) }))} />
                </td>
                <td>
                  <input value={r.name} onChange={(e) => setCal((c) => ({ ...c, tracks: c.tracks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
                </td>
                <td className="hint">
                  hue {Math.round(r.hueFrom)}–{Math.round(r.hueTo)}° · {(r.share * 100).toFixed(1)}%{r.likelyGrid ? ' · looks like grid lines' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Row>
        <Pick label="Analysis rate" value={String(fps)} options={['15', '30', '60'].map((v) => ({ value: v, label: `${v} fps` }))} onChange={(v) => setFps(+v)} />
        <Check label="Verify pitch with the video's audio" value={verify} onChange={setVerify} />
        <Check label="Set project tempo" value={setTempo} onChange={setSetTempo} />
        <button className="primary" disabled={!cal.tracks.some((r) => r.use)} onClick={read}>
          Read MIDI from video
        </button>
        {progress > 0 && <progress value={progress} max={1} />}
      </Row>
      {report && (
        <div className="notice">
          {report} <button onClick={() => setTab('midi')}>Open MIDI editor →</button>
        </div>
      )}
    </Section>
  );
}
