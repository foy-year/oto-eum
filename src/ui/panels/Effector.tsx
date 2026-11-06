import { useState } from 'react';
import { type EffectTarget, download, job, loadPcm, useStore } from '../store';
import { Check, Pick, Row, Section, Slider } from '../widgets';
import { EFFECTS, createEffect } from '../../core/render/effects';
import type { Effect, EffectType } from '../../core/types';
import { prepareSample, renderNoteTrack } from '../../core/render/sampler';
import { encodeWav } from '../../core/audio/wav';
import type { Pcm } from '../../core/audio/pcm';
import { play, stop } from '../player';
import { renderMix } from './SoundApplier';

/** Effect presets that are staples of 音MAD / YTPMV editing. */
const PRESETS: Record<string, Array<[EffectType, Record<string, number>]>> = {
  'Telephone': [['highpass', { freq: 400 }], ['lowpass', { freq: 3200 }], ['distortion', { drive: 3, mix: 0.4 }]],
  'Lo-fi / 8-bit': [['bitcrush', { bits: 6, downsample: 6 }], ['lowpass', { freq: 6000 }]],
  'Chipmunk (+12)': [['speed', { rate: 1, semitones: 12 }]],
  'Slow-mo (−12)': [['speed', { rate: 1, semitones: -12 }]],
  'Stutter roll': [['stutter', { length: 0.06, repeats: 6, decay: 0.05 }]],
  'Big hall': [['reverb', { size: 0.9, damp: 0.3, mix: 0.4 }]],
  'Slapback': [['delay', { time: 0.11, feedback: 0.1, mix: 0.3 }]],
  'Radio comp': [['highpass', { freq: 120 }], ['compressor', { threshold: -24, ratio: 6, makeup: 8 }], ['peaking', { freq: 2500, q: 1, gain: 4 }]],
};

export function Effector() {
  const { project, setEffects, selectedTrackId, selectedSampleId } = useStore();
  const [target, setTarget] = useState<EffectTarget>(selectedSampleId ? { kind: 'sample', id: selectedSampleId } : selectedTrackId ? { kind: 'track', id: selectedTrackId } : { kind: 'master' });
  const [add, setAdd] = useState<EffectType>('reverb');

  const chain: Effect[] =
    target.kind === 'master'
      ? project.masterEffects
      : target.kind === 'track'
        ? (project.tracks.find((t) => t.id === target.id)?.effects ?? [])
        : (project.samples.find((s) => s.id === target.id)?.effects ?? []);
  const setChain = (fx: Effect[]) => setEffects(target, fx);
  const targetKey = target.kind === 'master' ? 'master' : `${target.kind}:${target.id}`;

  const renderTarget = async (): Promise<Pcm> => {
    if (target.kind === 'master') return renderMix();
    if (target.kind === 'track') {
      const t = project.tracks.find((x) => x.id === target.id)!;
      const s = project.samples.find((x) => x.id === t.sampleId);
      if (!s) throw new Error('Assign a sample to this track first (Sound Applier).');
      return renderNoteTrack(t, s, await loadPcm(s.sourceId), { sampleRate: project.sampleRate });
    }
    const s = project.samples.find((x) => x.id === target.id)!;
    return prepareSample(await loadPcm(s.sourceId), s);
  };

  return (
    <div className="panel">
      <Section title="Target">
        <Row>
          <Pick
            label="Apply effects to"
            value={targetKey}
            options={[
              { value: 'master', label: 'Master bus' },
              ...project.tracks.map((t) => ({ value: `track:${t.id}`, label: `Track: ${t.name}` })),
              ...project.samples.map((s) => ({ value: `sample:${s.id}`, label: `Sample: ${s.name}` })),
            ]}
            onChange={(v) => {
              if (v === 'master') return setTarget({ kind: 'master' });
              const [kind, id] = v.split(':');
              setTarget({ kind: kind as 'track' | 'sample', id });
            }}
          />
          <button className="primary" onClick={() => job('Rendering preview…', async () => play(await renderTarget()))}>
            ▶ Preview with effects
          </button>
          <button onClick={stop}>■ Stop</button>
          <button onClick={() => job('Rendering…', async () => download(encodeWav(await renderTarget()), 'effected.wav', 'audio/wav'))}>Export WAV</button>
        </Row>
        <p className="hint">Sample effects are baked into the clip before it is pitched per note; track effects run on the rendered track; master runs on the full mix.</p>
      </Section>
      <Section
        title={`Effect chain (${chain.length})`}
        actions={
          <>
            <Pick label="" value={add} options={(Object.keys(EFFECTS) as EffectType[]).map((t) => ({ value: t, label: EFFECTS[t].label }))} onChange={setAdd} />
            <button onClick={() => setChain([...chain, createEffect(add)])}>+ Add</button>
            <Pick
              label=""
              value={undefined}
              placeholder="Presets…"
              options={Object.keys(PRESETS).map((k) => ({ value: k, label: k }))}
              onChange={(k) => k && setChain([...chain, ...PRESETS[k].map(([t, p]) => createEffect(t, p))])}
            />
          </>
        }
      >
        {chain.length === 0 && <div className="empty">No effects.</div>}
        {chain.map((fx, i) => {
          const spec = EFFECTS[fx.type];
          const patch = (p: Partial<Effect>) => setChain(chain.map((f) => (f.id === fx.id ? { ...f, ...p } : f)));
          return (
            <div key={fx.id} className={`fx ${fx.enabled ? '' : 'off'}`}>
              <header>
                <b>
                  {i + 1}. {spec.label}
                </b>
                <Check label="on" value={fx.enabled} onChange={(v) => patch({ enabled: v })} />
                <button disabled={i === 0} onClick={() => setChain(swap(chain, i, i - 1))}>
                  ↑
                </button>
                <button disabled={i === chain.length - 1} onClick={() => setChain(swap(chain, i, i + 1))}>
                  ↓
                </button>
                <button className="danger" onClick={() => setChain(chain.filter((f) => f.id !== fx.id))}>
                  ✕
                </button>
              </header>
              <Row>
                {spec.params.map((p) => (
                  <Slider
                    key={p.key}
                    label={p.label}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    unit={p.unit}
                    value={fx.params[p.key] ?? p.default}
                    onChange={(v) => patch({ params: { ...fx.params, [p.key]: v } })}
                  />
                ))}
              </Row>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = a.slice();
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}
