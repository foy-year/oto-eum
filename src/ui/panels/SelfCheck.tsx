import { useState } from 'react';
import { job, useStore } from '../store';
import { dsp } from '../dsp';
import { Pick, Row, Section } from '../widgets';
import type { ProjectCheck } from '../../core/render/check';

const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`);
const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '−∞');

/** Report: tuning, MIDI match, loudness, clipping per track; master; optional reference song. */
export function SelfCheck() {
  const { project, assets, updateSample } = useStore();
  const [refId, setRefId] = useState<string | undefined>(project.backingAudioId);
  const [res, setRes] = useState<ProjectCheck | null>(null);
  const run = () =>
    job('Checking the render…', async () => {
      const p = useStore.getState().project;
      // compare the parts we made, without the backing track itself
      setRes(await dsp('check', { project: { ...p, backingAudioId: refId === p.backingAudioId ? undefined : p.backingAudioId }, referenceId: refId }));
    });
  return (
    <Section title="Self-check" actions={<button className="primary" onClick={run} disabled={!project.tracks.some((t) => t.sampleId)}>Run checks</button>}>
      <Row>
        <Pick label="Compare with reference (optional)" value={refId} placeholder="— none —" options={assets.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => setRefId(v || undefined)} />
        <span className="hint">e.g. the original song: checks key/octave and timing of the whole mix.</span>
      </Row>
      {res && (
        <>
          <table className="list">
            <thead>
              <tr>
                <th>Track</th>
                <th title="Notes measured / median error / share within ±50 cents">Tuning</th>
                <th title="How well the rendered pitch classes match the track's MIDI">MIDI match</th>
                <th>Loudness</th>
                <th>Peak</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {res.tracks.map((t) => {
                const sample = project.samples.find((s) => s.id === project.tracks.find((x) => x.id === t.trackId)?.sampleId);
                return (
                  <tr key={t.trackId}>
                    <td>{t.name}</td>
                    <td>{t.pitch ? (t.pitch.checked ? `${t.pitch.checked} · ${Math.round(t.pitch.medianError * 100)}¢ · ${pct(t.pitch.within50cents)}` : 'no solo notes') : 'unpitched'}</td>
                    <td>{pct(t.midiMatch)}</td>
                    <td>{db(t.loudness)} LUFS</td>
                    <td>{db(t.peakDb)} dB</td>
                    <td>
                      {t.issues.length ? t.issues.map((i) => <div key={i}>⚠ {i}</div>) : '✓'}
                      {t.fixCents != null && sample && (
                        <button onClick={() => updateSample(sample.id, { rootCents: (sample.rootCents ?? 0) + t.fixCents! })}>
                          Fix: set root {t.fixCents > 0 ? '+' : ''}
                          {t.fixCents}¢
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Master: {db(res.master.integrated)} LUFS, true peak {db(res.master.truePeak)} dBTP
            {res.reference && ` · reference agreement ${pct(res.reference.agreement)} at offset ${res.reference.offset.toFixed(2)} s`}
          </p>
          {res.issues.map((i) => (
            <div key={i} className="hint">
              ⚠ {i}
            </div>
          ))}
          {!res.issues.length && res.tracks.every((t) => !t.issues.length) && <div className="notice">All checks passed.</div>}
        </>
      )}
    </Section>
  );
}
