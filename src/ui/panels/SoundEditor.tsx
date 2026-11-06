import { useEffect, useMemo, useState } from 'react';
import { job, loadPcm, useStore } from '../store';
import { Check, Num, Pick, Pitch, Row, Section, Waveform, fmt } from '../widgets';
import { type Pcm, slice } from '../../core/audio/pcm';
import { detectRootPitch, midiToName } from '../../core/analysis/pitch';
import { detectOnsets, sliceAtOnsets } from '../../core/analysis/onset';
import { createSample } from '../../core/project';
import { prepareSample, renderTrack } from '../../core/render/sampler';
import type { Sample } from '../../core/types';
import { play, stop } from '../player';

/**
 * Sound Editor: cut samples (instruments) out of uploaded sources, detect their
 * pitch, set playback behaviour, audition them, bounce processed versions.
 */
export function SoundEditor() {
  const { assets, project, selectedAssetId, selectedSampleId, select, addSample, updateSample, removeSample, addPcmAsset } = useStore();
  const asset = assets.find((a) => a.id === selectedAssetId) ?? assets[0];
  const [pcm, setPcm] = useState<Pcm | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [onsets, setOnsets] = useState<number[]>([]);
  const [sensitivity, setSensitivity] = useState(1.5);
  const [testPitch, setTestPitch] = useState(60);

  useEffect(() => {
    setPcm(null);
    setOnsets([]);
    if (asset) void job('Decoding audio…', async () => setPcm(await loadPcm(asset.id)));
  }, [asset?.id]);

  const samples = project.samples.filter((s) => s.sourceId === asset?.id);
  const current = project.samples.find((s) => s.id === selectedSampleId);
  const regions = useMemo(() => samples.map((s) => ({ start: s.start, end: s.end, label: s.name, active: s.id === selectedSampleId })), [samples, selectedSampleId]);

  if (!asset) return <div className="panel empty">Upload a source in the Library first.</div>;

  const makeSample = async (start: number, end: number, name: string) => {
    if (!pcm) return;
    const root = detectRootPitch(slice(pcm, start, end));
    const s = createSample(asset.id, start, end, {
      name,
      rootPitch: root ? Math.round(root.midi) : 60,
      rootCents: root ? Math.round((root.midi - Math.round(root.midi)) * 100) : 0,
      // unpitched material → don't retune by default
      pitchMode: root && root.confidence > 0.6 ? 'resample' : 'fixed',
    });
    addSample(s);
  };

  const audition = (s: Sample, pitch?: number) => {
    if (!pcm) return;
    const clip = prepareSample(pcm, s, pcm.sampleRate);
    if (pitch == null) return play(clip);
    const len = (s.end - s.start) * 1.5;
    play(renderTrack([{ id: 'a', pitch, start: 0, duration: len, velocity: 1 }], clip, s, { sampleRate: pcm.sampleRate }));
  };

  return (
    <div className="panel">
      <Section
        title="Source"
        actions={
          <Pick
            label=""
            value={asset.id}
            options={assets.map((a) => ({ value: a.id, label: `${a.kind === 'video' ? '🎞' : '🎵'} ${a.name}` }))}
            onChange={(id) => select({ selectedAssetId: id })}
          />
        }
      >
        <Waveform pcm={pcm} selection={selection} onSelect={setSelection} markers={onsets} regions={regions} height={160} />
        <Row>
          <span className="hint">{selection ? `Selection ${fmt(selection.start)} – ${fmt(selection.end)} (${(selection.end - selection.start).toFixed(3)} s)` : 'Drag on the waveform to select a region.'}</span>
        </Row>
        <Row>
          <button disabled={!pcm} onClick={() => pcm && play(selection && selection.end > selection.start ? slice(pcm, selection.start, selection.end) : pcm)}>
            ▶ Play {selection && selection.end > selection.start ? 'selection' : 'all'}
          </button>
          <button onClick={stop}>■ Stop</button>
          <button disabled={!selection || selection.end - selection.start < 0.01} onClick={() => selection && makeSample(selection.start, selection.end, `${asset.name.replace(/\.\w+$/, '')} ${samples.length + 1}`)}>
            ✚ Create sample from selection
          </button>
        </Row>
        <Row>
          <Num label="Onset sensitivity" value={sensitivity} step={0.1} onChange={setSensitivity} />
          <button disabled={!pcm} onClick={() => pcm && setOnsets(detectOnsets(selection && selection.end > selection.start ? slice(pcm, selection.start, selection.end) : pcm, { sensitivity }).onsets.map((t) => t + (selection && selection.end > selection.start ? selection.start : 0)))}>
            Detect onsets
          </button>
          <button
            disabled={!onsets.length}
            onClick={async () => {
              const dur = pcm ? pcm.channels[0].length / pcm.sampleRate : 0;
              const base = selection && selection.end > selection.start ? selection : { start: 0, end: dur };
              const local = onsets.filter((t) => t > base.start && t < base.end).map((t) => t - base.start);
              const parts = sliceAtOnsets(base.end - base.start, local, 0.04);
              for (const [i, r] of parts.entries()) await makeSample(base.start + r.start, base.start + r.end, `slice ${i + 1}`);
            }}
          >
            Auto-slice into {Math.max(0, onsets.length)} samples
          </button>
        </Row>
      </Section>

      <Section title={`Samples from this source (${samples.length})`}>
        <table className="list">
          <tbody>
            {samples.map((s) => (
              <tr key={s.id} className={s.id === selectedSampleId ? 'sel' : ''} onClick={() => select({ selectedSampleId: s.id })}>
                <td>{s.name}</td>
                <td>
                  {fmt(s.start)} – {fmt(s.end)}
                </td>
                <td>
                  root {midiToName(s.rootPitch)} {s.pitchMode === 'fixed' ? '(fixed)' : ''}
                </td>
                <td className="actions">
                  <button onClick={() => audition(s)}>▶</button>
                  <button className="danger" onClick={() => removeSample(s.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {current && current.sourceId === asset.id && (
        <Section title={`Sample: ${current.name}`}>
          <Row>
            <label className="field">
              <span>Name</span>
              <input value={current.name} onChange={(e) => updateSample(current.id, { name: e.target.value })} />
            </label>
            <Num label="Start" value={current.start} step={0.001} unit="s" onChange={(v) => updateSample(current.id, { start: v })} />
            <Num label="End" value={current.end} step={0.001} unit="s" onChange={(v) => updateSample(current.id, { end: v })} />
            <button onClick={() => selection && updateSample(current.id, { start: selection.start, end: selection.end })} disabled={!selection}>
              Set to selection
            </button>
          </Row>
          <Row>
            <Pitch label="Root" value={current.rootPitch} onChange={(v) => updateSample(current.id, { rootPitch: v })} />
            <Num label="Cents" value={current.rootCents ?? 0} step={1} onChange={(v) => updateSample(current.id, { rootCents: v })} />
            <button
              onClick={() => {
                if (!pcm) return;
                const r = detectRootPitch(slice(pcm, current.start, current.end));
                if (r) updateSample(current.id, { rootPitch: Math.round(r.midi), rootCents: Math.round((r.midi - Math.round(r.midi)) * 100) });
                else alert('No stable pitch found — consider pitch mode "fixed".');
              }}
            >
              Detect pitch
            </button>
            <Pick label="Pitch mode" value={current.pitchMode} options={[{ value: 'resample', label: 'resample (classic)' }, { value: 'fixed', label: 'fixed (no pitch)' }]} onChange={(v) => updateSample(current.id, { pitchMode: v })} />
            <Pick label="Sustain" value={current.sustain} options={[{ value: 'cut', label: 'cut at note end' }, { value: 'full', label: 'one-shot (full)' }, { value: 'loop', label: 'loop' }]} onChange={(v) => updateSample(current.id, { sustain: v })} />
          </Row>
          <Row>
            <Num label="Gain" value={current.gain} step={0.05} onChange={(v) => updateSample(current.id, { gain: v })} />
            <Num label="Fade in" value={current.fadeIn} step={0.001} unit="s" onChange={(v) => updateSample(current.id, { fadeIn: v })} />
            <Num label="Fade out" value={current.fadeOut} step={0.001} unit="s" onChange={(v) => updateSample(current.id, { fadeOut: v })} />
            <Num label="Release" value={current.release ?? 0.03} step={0.005} unit="s" onChange={(v) => updateSample(current.id, { release: v })} />
            <Check label="Reverse" value={current.reverse} onChange={(v) => updateSample(current.id, { reverse: v })} />
          </Row>
          <Row>
            <button onClick={() => audition(current)}>▶ Audition</button>
            <Pitch label="at note" value={testPitch} onChange={setTestPitch} />
            <button onClick={() => audition(current, testPitch)}>▶ Play at {midiToName(testPitch)}</button>
            <button
              onClick={() =>
                job('Bouncing…', async () => {
                  if (!pcm) return;
                  await addPcmAsset(`${current.name} (bounced).wav`, prepareSample(pcm, current, pcm.sampleRate));
                })
              }
            >
              Bounce to new audio file
            </button>
          </Row>
          <p className="hint">Effects on this sample are edited in the Sound Effector tab (target: this sample).</p>
        </Section>
      )}
    </div>
  );
}
