import { useState } from 'react';
import { download, job, loadPcm, useStore } from '../store';
import { Check, Num, Pick, Row, Section } from '../widgets';
import { mixProject } from '../../core/render/mix';
import { encodeWav } from '../../core/audio/wav';
import { type Pcm, durationOf } from '../../core/audio/pcm';
import { midiToName } from '../../core/analysis/pitch';
import { play, stop } from '../player';

/** Shared render cache so the video panel can reuse the last mix. */
export const lastMix: { pcm: Pcm | null; key: string } = { pcm: null, key: '' };

export async function renderMix(onProgress?: (f: number, l: string) => void): Promise<Pcm> {
  const { project } = useStore.getState();
  const key = JSON.stringify([project.tracks, project.samples, project.masterEffects, project.backingAudioId, project.backingGain, project.sampleRate]);
  if (lastMix.pcm && lastMix.key === key) return lastMix.pcm;
  const { master } = await mixProject(project, loadPcm, { onProgress });
  lastMix.pcm = master;
  lastMix.key = key;
  return master;
}

/** Sound Applier: assign samples to MIDI tracks, mix, render. */
export function SoundApplier() {
  const { project, assets, updateTrack, update, setTab, select } = useStore();
  const [label, setLabel] = useState('');
  const sampleOptions = project.samples.map((s) => ({ value: s.id, label: `${s.name} — root ${midiToName(s.rootPitch)}${assets.find((a) => a.id === s.sourceId)?.kind === 'video' ? ' 🎞' : ''}` }));
  const videoIds = project.videoTrackIds;
  return (
    <div className="panel">
      <Section title="Assign sounds to MIDI tracks">
        {project.tracks.length === 0 && <div className="empty">No MIDI tracks yet.</div>}
        {project.samples.length === 0 && <div className="empty">No samples yet — create some in the Sound Editor.</div>}
        <table className="list">
          <thead>
            <tr>
              <th>Track</th>
              <th>Notes</th>
              <th>Sample</th>
              <th>Gain</th>
              <th>Pan</th>
              <th>Mute</th>
              <th>In video</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {project.tracks.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.notes.length}</td>
                <td>
                  <Pick label="" value={t.sampleId} placeholder="— none —" options={sampleOptions} onChange={(v) => updateTrack(t.id, { sampleId: v || undefined })} />
                </td>
                <td>
                  <Num label="" value={t.gain ?? 1} step={0.05} width={60} onChange={(v) => updateTrack(t.id, { gain: v })} />
                </td>
                <td>
                  <Num label="" value={t.pan ?? 0} step={0.1} min={-1} max={1} width={60} onChange={(v) => updateTrack(t.id, { pan: v })} />
                </td>
                <td>
                  <Check label="" value={!!t.muted} onChange={(v) => updateTrack(t.id, { muted: v })} />
                </td>
                <td>
                  <Check
                    label=""
                    value={!videoIds || videoIds.includes(t.id)}
                    onChange={(v) =>
                      update((p) => {
                        const all = p.videoTrackIds ?? p.tracks.map((x) => x.id);
                        p.videoTrackIds = v ? [...new Set([...all, t.id])] : all.filter((id) => id !== t.id);
                      })
                    }
                  />
                </td>
                <td className="actions">
                  <button onClick={() => (select({ selectedTrackId: t.id }), setTab('midi'))}>Edit notes</button>
                  <button onClick={() => (setTab('fx'), select({ selectedTrackId: t.id }))}>FX</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Mix">
        <Row>
          <Pick label="Backing audio" value={project.backingAudioId} placeholder="— none —" options={assets.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => update((p) => void (p.backingAudioId = v || undefined))} />
          <Num label="Backing gain" value={project.backingGain ?? 1} step={0.05} onChange={(v) => update((p) => void (p.backingGain = v))} />
          <Pick label="Sample rate" value={String(project.sampleRate)} options={['44100', '48000'].map((v) => ({ value: v, label: v }))} onChange={(v) => update((p) => void (p.sampleRate = +v))} />
        </Row>
        <Row>
          <button className="primary" onClick={() => job('Rendering mix…', async () => play(await renderMix((f, l) => setLabel(`${l} ${(f * 100).toFixed(0)}%`))))}>
            ▶ Render &amp; play
          </button>
          <button onClick={stop}>■ Stop</button>
          <button
            onClick={() =>
              job('Rendering WAV…', async () => {
                const pcm = await renderMix();
                download(encodeWav(pcm), `${project.name}.wav`, 'audio/wav');
                setLabel(`Exported ${durationOf(pcm).toFixed(2)} s`);
              })
            }
          >
            Export WAV
          </button>
          <span className="hint">{label}</span>
        </Row>
      </Section>
    </div>
  );
}
