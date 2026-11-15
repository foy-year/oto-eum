import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Num, Pick, Row, Section, fmt } from '../widgets';
import { type Pcm, slice } from '../../core/audio/pcm';
import { DRUM_PATTERNS, drumPattern, findDrumHits, type DrumHit, type DrumKind } from '../../core/analysis/drums';
import { createEffect } from '../../core/render/effects';
import { createSample, createTrack } from '../../core/project';
import { endTime } from '../../core/midi/midi';
import type { MediaAsset } from '../../core/types';
import { play } from '../player';

const KINDS: DrumKind[] = ['kick', 'snare', 'hat'];
const NAMES: Record<DrumKind, string> = { kick: 'Kick', snare: 'Snare', hat: 'Hat' };

/** Find kick/snare/hat sounds in the source and turn them into drum tracks. */
export function DrumKit({ asset, pcm }: { asset: MediaAsset; pcm: Pcm | null }) {
  const { project, update } = useStore();
  const [hits, setHits] = useState<Record<DrumKind, DrumHit[]> | null>(null);
  const [pick, setPick] = useState<Record<DrumKind, number>>({ kick: 0, snare: 0, hat: 0 });
  const [pattern, setPattern] = useState('drive');
  const songEnd = endTime(project.tracks.filter((t) => !/\(kit\)$/.test(t.name)));
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(songEnd || 8);
  useEffect(() => setHits(null), [asset.id]);
  useEffect(() => {
    if (songEnd) setTo(songEnd);
  }, [songEnd]);

  const create = () => {
    if (!hits || !pcm) return;
    const notes = drumPattern(pattern, { bpm: project.bpm, from, to, gridOffset: project.gridOffset });
    update((p) => {
      // replace a previous kit
      const old = p.tracks.filter((t) => / \(kit\)$/.test(t.name));
      p.tracks = p.tracks.filter((t) => !old.includes(t));
      p.samples = p.samples.filter((s) => !old.some((t) => t.sampleId === s.id));
      const melodic = p.videoTrackIds ?? p.tracks.map((t) => t.id);
      for (const kind of KINDS) {
        const h = hits[kind][pick[kind]];
        if (!h) continue;
        const s = createSample(asset.id, Math.max(0, h.time - 0.008), h.time + h.length, {
          name: `${NAMES[kind]} @${h.time.toFixed(2)}`,
          pitchMode: 'fixed',
          sustain: 'full',
          fadeOut: kind === 'hat' ? 0.02 : 0.05,
          effects: [createEffect('normalize', { peak: 0.9 })],
        });
        p.samples.push(s);
        const fx = kind === 'kick' ? [createEffect('lowpass', { freq: 2000 })] : kind === 'hat' ? [createEffect('highpass', { freq: 5000 })] : [createEffect('highpass', { freq: 200 })];
        p.tracks.push(createTrack(`${NAMES[kind]} (kit)`, { notes: notes[kind], sampleId: s.id, gain: kind === 'hat' ? 0.35 : kind === 'snare' ? 0.7 : 1, levelOffset: kind === 'hat' ? -8 : kind === 'snare' ? -2 : 1, effects: fx }));
      }
      p.videoTrackIds = melodic; // drums stay audio-only (tick "In video" to show them)
    });
  };

  return (
    <Section title="Drum kit from this source" actions={<button disabled={!pcm} onClick={() => pcm && setHits(findDrumHits(pcm))}>Find drum sounds</button>}>
      {!hits && <p className="hint">Finds kick-, snare- and hat-like hits (thumps, plosives, hiss) in this source and builds drum tracks from them on the project tempo.</p>}
      {hits && (
        <>
          <div className="drumcols">
            {KINDS.map((k) => (
              <div key={k}>
                <b>{NAMES[k]}</b>
                {hits[k].length === 0 && <div className="hint">none found</div>}
                {hits[k].map((h, i) => (
                  <label key={h.time} className="field">
                    <input type="radio" name={`dk-${k}`} checked={pick[k] === i} onChange={() => setPick({ ...pick, [k]: i })} />
                    <button onClick={() => pcm && play(slice(pcm, Math.max(0, h.time - 0.008), h.time + h.length))}>▶</button>
                    <span>{fmt(h.time)}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <Row>
            <Pick label="Pattern" value={pattern} options={Object.entries(DRUM_PATTERNS).map(([v, p]) => ({ value: v, label: p.label }))} onChange={setPattern} />
            <Num label="From" value={from} step={0.1} unit="s" onChange={(v) => setFrom(Math.max(0, v))} />
            <Num label="To" value={to} step={0.1} unit="s" onChange={setTo} />
            <span className="hint">
              {project.bpm} BPM, grid from {(project.gridOffset ?? 0).toFixed(3)} s
            </span>
            <button className="primary" onClick={create}>
              Create drum tracks
            </button>
          </Row>
        </>
      )}
    </Section>
  );
}
