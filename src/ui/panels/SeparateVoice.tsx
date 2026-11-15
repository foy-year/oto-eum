import { useEffect, useState } from 'react';
import { job, useStore } from '../store';
import { Pick, Row, Section, Slider } from '../widgets';
import type { MediaAsset } from '../../core/types';
import { getModelInfo, removeModel, saveModel, saveModelFromUrl, separateBuiltIn, separateNeural, type ModelInfo } from '../separate';

/** Separate a source into vocals / accompaniment (built-in) or 4 stems (Demucs). */
export function SeparateVoice({ asset }: { asset: MediaAsset }) {
  const { assets, project, addPcmAsset, update } = useStore();
  const [engine, setEngine] = useState<'builtin' | 'neural'>('builtin');
  const [strength, setStrength] = useState(0.6);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [url, setUrl] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  useEffect(() => void getModelInfo().then(setModel), []);
  const stems = assets.filter((a) => a.derivedFrom === asset.id);
  const vocals = stems.find((a) => a.stem === 'vocals');
  const base = asset.name.replace(/\.\w+$/, '');
  const threads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? navigator.hardwareConcurrency : 1;

  const run = () =>
    job(engine === 'neural' ? 'Separating with Demucs (this can take a while)…' : 'Separating voice…', async () => {
      const t0 = performance.now();
      if (engine === 'builtin') {
        const r = await separateBuiltIn(asset.id, strength, setProgress);
        await addPcmAsset(`${base} — vocals.wav`, r.vocals, { derivedFrom: asset.id, stem: 'vocals' });
        await addPcmAsset(`${base} — accompaniment.wav`, r.accompaniment, { derivedFrom: asset.id, stem: 'accompaniment' });
        setStatus(`Built-in separation done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
      } else {
        const r = await separateNeural(asset.id, (f, l) => (setProgress(f), l && setStatus(l)));
        for (const s of ['vocals', 'drums', 'bass', 'other']) await addPcmAsset(`${base} — ${s}.wav`, r.stems[s], { derivedFrom: asset.id, stem: s });
        setStatus(`Demucs (${r.backend}) done in ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
      }
      setProgress(0);
    });

  return (
    <Section title="Separate voice / stems" actions={<Pick label="" value={engine} options={[{ value: 'builtin', label: 'Built-in (fast, no download)' }, { value: 'neural', label: 'Demucs neural (best, needs model file)' }]} onChange={setEngine} />}>
      {engine === 'builtin' ? (
        <Row>
          <Slider label="Strength" min={0} max={1} step={0.05} value={strength} onChange={setStrength} />
          <span className="hint">Centre-panned + harmonic + pitch-following mask. Good at removing background music under speech/singing.</span>
        </Row>
      ) : (
        <>
          <p className="hint">
            Uses HTDemucs (4 stems: vocals, drums, bass, other) in your browser — WebGPU if available, otherwise CPU ({threads} thread{threads > 1 ? 's' : ''}
            {threads === 1 ? '; slow — roughly 4–5× the audio length' : ''}). The model weights (Meta) are licensed for personal/research use only, so oto-eum
            does not include them: load an <code>htdemucs.onnx</code> file you obtained yourself (e.g. from the <code>demucs</code> npm package). It is kept in this
            browser.
          </p>
          <Row>
            {model ? (
              <>
                <span>
                  Model: <b>{model.name}</b> ({(model.size / 1048576).toFixed(0)} MB)
                </span>
                <button className="danger" onClick={() => void removeModel().then(() => setModel(null))}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Model file</span>
                  <input type="file" accept=".onnx" onChange={(e) => e.target.files?.[0] && void job('Storing model…', async () => setModel(await saveModel(e.target.files![0], e.target.files![0].name)))} />
                </label>
                <span className="hint">or</span>
                <input placeholder="https://…/htdemucs.onnx" style={{ width: 260 }} value={url} onChange={(e) => setUrl(e.target.value)} />
                <button disabled={!url} onClick={() => job('Downloading model…', async () => setModel(await saveModelFromUrl(url, setProgress)))}>
                  Download
                </button>
              </>
            )}
          </Row>
        </>
      )}
      <Row>
        <button className="primary" disabled={engine === 'neural' && !model} onClick={run}>
          Separate {asset.name}
        </button>
        {progress > 0 && <progress value={progress} max={1} />}
        <span className="hint">{status}</span>
      </Row>
      {stems.length > 0 && (
        <Row>
          <span className="hint">Stems: {stems.map((s) => s.stem).join(', ')}.</span>
          {vocals && (
            <button
              onClick={() =>
                update((p) => {
                  p.samples = p.samples.map((s) => (s.sourceId === asset.id && !s.pitchMode.startsWith('fixed') ? { ...s, audioId: vocals.id } : s));
                })
              }
              title="Pitched samples of this source take their sound from the vocals stem; the picture stays from the video"
            >
              Use vocals for this source&apos;s samples ({project.samples.filter((s) => s.sourceId === asset.id && s.pitchMode !== 'fixed').length})
            </button>
          )}
        </Row>
      )}
    </Section>
  );
}
