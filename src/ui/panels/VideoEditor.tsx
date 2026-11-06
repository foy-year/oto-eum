import { useMemo, useRef, useState } from 'react';
import { job, loadPcm, useStore } from '../store';
import { Check, Num, Pick, Row, Section, fmt } from '../widgets';
import { projectVideoEvents } from '../../core/video/timeline';
import { endTime } from '../../core/midi/midi';
import { detectOnsets } from '../../core/analysis/onset';
import { type VideoClip, uid } from '../../core/types';
import { VideoPreview } from '../VideoPreview';
import { renderMix } from './SoundApplier';

const PRESET_RECTS: Record<string, VideoClip['rect']> = {
  full: { x: 0, y: 0, w: 1, h: 1 },
  left: { x: 0, y: 0, w: 0.5, h: 1 },
  right: { x: 0.5, y: 0, w: 0.5, h: 1 },
  top: { x: 0, y: 0, w: 1, h: 0.5 },
  bottom: { x: 0, y: 0.5, w: 1, h: 0.5 },
  'picture-in-picture': { x: 0.66, y: 0.66, w: 0.3, h: 0.3 },
};

/**
 * Video Editor: manual clip placement (layers, transforms, colour) on top of
 * the synced video, plus beat-cut generation (cut a video on every onset).
 */
export function VideoEditor() {
  const { project, assets, update } = useStore();
  const videos = assets.filter((a) => a.kind === 'video');
  const [selId, setSelId] = useState<string>();
  const [beatSource, setBeatSource] = useState<string>('mix');
  const [beatVideo, setBeatVideo] = useState<string>();
  const [beatMode, setBeatMode] = useState<'sequential' | 'random' | 'same'>('sequential');
  const [sens, setSens] = useState(1.5);
  const strip = useRef<HTMLDivElement>(null);

  const events = useMemo(() => projectVideoEvents(project, assets, endTime(project.tracks)), [project, assets]);
  const total = Math.max(1, ...events.map((e) => e.end));
  const clips = project.videoClips;
  const sel = clips.find((c) => c.id === selId);
  const patch = (id: string, p: Partial<VideoClip>) => update((pr) => void (pr.videoClips = pr.videoClips.map((c) => (c.id === id ? { ...c, ...p } : c))));

  const addClip = (sourceId: string) => {
    const a = assets.find((x) => x.id === sourceId)!;
    const c: VideoClip = { id: uid('c'), sourceId, start: 0, sourceIn: 0, sourceOut: Math.min(a.duration, 5), rate: 1, layer: clips.length, rect: PRESET_RECTS.full, opacity: 1 };
    update((p) => void p.videoClips.push(c));
    setSelId(c.id);
  };

  const beatCut = () =>
    job('Detecting beats & cutting…', async () => {
      const vid = videos.find((v) => v.id === beatVideo) ?? videos[0];
      if (!vid) throw new Error('Upload a video first.');
      const audio = beatSource === 'mix' ? await renderMix() : await loadPcm(beatSource);
      const { onsets } = detectOnsets(audio, { sensitivity: sens, minInterval: 0.08 });
      const dur = audio.channels[0].length / audio.sampleRate;
      const points = [...onsets, dur];
      const out: VideoClip[] = [];
      let cursor = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const len = points[i + 1] - points[i];
        let sIn = beatMode === 'random' ? Math.random() * Math.max(0, vid.duration - len) : beatMode === 'same' ? 0 : cursor;
        if (sIn + len > vid.duration) sIn = cursor = 0;
        out.push({ id: uid('c'), sourceId: vid.id, start: points[i], sourceIn: sIn, sourceOut: Math.min(vid.duration, sIn + len), rate: 1, layer: 0, rect: PRESET_RECTS.full, flipX: i % 2 === 1, opacity: 1 });
        cursor = sIn + len;
      }
      update((p) => void p.videoClips.push(...out));
    });

  return (
    <div className="panel">
      <Section
        title={`Clips (${clips.length})`}
        actions={
          <>
            <Pick label="" value={undefined} placeholder="+ Add clip from video…" options={videos.map((v) => ({ value: v.id, label: v.name }))} onChange={(v) => v && addClip(v)} />
            <button className="danger" disabled={!clips.length} onClick={() => confirm('Remove all manual clips?') && update((p) => void (p.videoClips = []))}>
              Clear clips
            </button>
          </>
        }
      >
        <div className="strip" ref={strip}>
          {events
            .filter((e) => e.layer < 1000)
            .map((e, i) => (
              <div key={`s${i}`} className="strip-ev sync" style={{ left: `${(e.start / total) * 100}%`, width: `${((e.end - e.start) / total) * 100}%` }} />
            ))}
          {clips.map((c) => (
            <div
              key={c.id}
              className={`strip-ev clip ${c.id === selId ? 'sel' : ''}`}
              title={assets.find((a) => a.id === c.sourceId)?.name}
              onClick={() => setSelId(c.id)}
              style={{ left: `${(c.start / total) * 100}%`, width: `${(((c.sourceOut - c.sourceIn) / c.rate) / total) * 100}%`, top: 22 + (c.layer % 4) * 10 }}
            />
          ))}
        </div>
        <p className="hint">Top row: MIDI-synced events. Below: manual clips (click to edit). Manual clips draw above synced video.</p>
        {sel && (
          <div className="fx">
            <header>
              <b>{assets.find((a) => a.id === sel.sourceId)?.name}</b>
              <button className="danger" onClick={() => update((p) => void (p.videoClips = p.videoClips.filter((c) => c.id !== sel.id)))}>
                Delete clip
              </button>
            </header>
            <Row>
              <Num label="Timeline start" value={sel.start} step={0.01} unit="s" onChange={(v) => patch(sel.id, { start: Math.max(0, v) })} />
              <Num label="Source in" value={sel.sourceIn} step={0.01} unit="s" onChange={(v) => patch(sel.id, { sourceIn: Math.max(0, v) })} />
              <Num label="Source out" value={sel.sourceOut} step={0.01} unit="s" onChange={(v) => patch(sel.id, { sourceOut: v })} />
              <Num label="Speed" value={sel.rate} step={0.05} unit="x" onChange={(v) => patch(sel.id, { rate: Math.max(0.05, v) })} />
              <Num label="Layer" value={sel.layer} step={1} onChange={(v) => patch(sel.id, { layer: Math.round(v) })} />
              <span className="hint">ends at {fmt(sel.start + (sel.sourceOut - sel.sourceIn) / sel.rate)}</span>
            </Row>
            <Row>
              <Pick label="Position" value={undefined} placeholder="preset…" options={Object.keys(PRESET_RECTS).map((k) => ({ value: k, label: k }))} onChange={(k) => k && patch(sel.id, { rect: PRESET_RECTS[k] })} />
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <Num key={k} label={k} value={sel.rect[k]} step={0.01} width={60} onChange={(v) => patch(sel.id, { rect: { ...sel.rect, [k]: v } })} />
              ))}
            </Row>
            <Row>
              <Check label="Flip X" value={!!sel.flipX} onChange={(v) => patch(sel.id, { flipX: v })} />
              <Check label="Flip Y" value={!!sel.flipY} onChange={(v) => patch(sel.id, { flipY: v })} />
              <Check label="Reverse" value={!!sel.reverse} onChange={(v) => patch(sel.id, { reverse: v })} />
              <Check label="Invert" value={!!sel.invert} onChange={(v) => patch(sel.id, { invert: v })} />
              <Num label="Hue" value={sel.hue ?? 0} step={5} unit="°" onChange={(v) => patch(sel.id, { hue: v })} />
              <Num label="Opacity" value={sel.opacity ?? 1} step={0.05} min={0} max={1} onChange={(v) => patch(sel.id, { opacity: v })} />
            </Row>
          </div>
        )}
      </Section>
      <Section title="Beat-cut generator">
        <Row>
          <Pick label="Cut video" value={beatVideo ?? videos[0]?.id} options={videos.map((v) => ({ value: v.id, label: v.name }))} onChange={setBeatVideo} />
          <Pick label="On onsets of" value={beatSource} options={[{ value: 'mix', label: 'Project mix' }, ...assets.map((a) => ({ value: a.id, label: a.name }))]} onChange={setBeatSource} />
          <Pick
            label="Source position"
            value={beatMode}
            options={[
              { value: 'sequential', label: 'sequential (continue)' },
              { value: 'random', label: 'random jumps' },
              { value: 'same', label: 'restart each hit' },
            ]}
            onChange={setBeatMode}
          />
          <Num label="Sensitivity" value={sens} step={0.1} onChange={setSens} />
          <button className="primary" disabled={!videos.length} onClick={beatCut}>
            Generate cuts
          </button>
        </Row>
      </Section>
      <Section title="Preview & export">
        <VideoPreview events={events} settings={project.videoSync} getAudio={() => renderMix()} name={project.name} />
      </Section>
    </div>
  );
}
