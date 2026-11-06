import { useEffect, useState } from 'react';
import { job, loadPcm, useStore } from '../store';
import { Check, Num, Pick, Row, Section, Waveform, fmt } from '../widgets';
import type { Pcm } from '../../core/audio/pcm';
import { transcribe } from '../../core/midi/transcribe';
import { importMidi, monophonize, splitVoices } from '../../core/midi/midi';
import { detectOnsets, estimateTempo } from '../../core/analysis/onset';
import { createTrack } from '../../core/project';
import { slice } from '../../core/audio/pcm';

/** MIDI Extractor: audio/video → notes (Basic Pitch or YIN), plus .mid import. */
export function MidiExtract() {
  const { assets, selectedAssetId, select, addTrack, update, setTab } = useStore();
  const asset = assets.find((a) => a.id === selectedAssetId) ?? assets[0];
  const [pcm, setPcm] = useState<Pcm | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [engine, setEngine] = useState<'poly' | 'mono'>('poly');
  const [onsetT, setOnsetT] = useState(0.5);
  const [frameT, setFrameT] = useState(0.3);
  const [minHz, setMinHz] = useState(0);
  const [maxHz, setMaxHz] = useState(0);
  const [voices, setVoices] = useState(1);
  const [melodyOnly, setMelodyOnly] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<string>();

  useEffect(() => {
    setPcm(null);
    if (asset) void job('Decoding audio…', async () => setPcm(await loadPcm(asset.id)));
  }, [asset?.id]);

  const run = () =>
    job(engine === 'poly' ? 'Running Basic Pitch (neural transcription)…' : 'Tracking pitch…', async () => {
      if (!pcm || !asset) return;
      const hasSel = selection && selection.end - selection.start > 0.1;
      let notes = await transcribe(pcm, {
        engine,
        start: hasSel ? selection!.start : undefined,
        end: hasSel ? selection!.end : undefined,
        onsetThreshold: onsetT,
        frameThreshold: frameT,
        minHz: minHz || undefined,
        maxHz: maxHz || undefined,
        melodiaTrick: true,
        onProgress: setProgress,
      });
      if (melodyOnly) notes = monophonize(notes, 'highest');
      const base = asset.name.replace(/\.\w+$/, '');
      const groups = voices > 1 ? splitVoices(notes, voices) : [notes];
      groups.forEach((g, i) => addTrack(createTrack(groups.length > 1 ? `${base} voice ${i + 1}` : `${base} (${engine})`, { notes: g })));
      setResult(`Extracted ${notes.length} notes into ${groups.length} track(s).`);
    });

  return (
    <div className="panel">
      <Section title="Import a MIDI file">
        <input
          type="file"
          accept=".mid,.midi,audio/midi"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f)
              return;
            void job('Importing MIDI…', async () => {
              const { bpm, tracks } = importMidi(await f.arrayBuffer());
              update((p) => {
                p.bpm = Math.round(bpm * 100) / 100;
                p.tracks.push(...tracks);
              });
              setResult(`Imported ${tracks.length} track(s) at ${bpm.toFixed(1)} BPM.`);
            });
          }}
        />
      </Section>

      {!asset ? (
        <div className="empty">Upload a source in the Library to extract MIDI from audio/video.</div>
      ) : (
        <Section
          title="Extract MIDI from audio / video"
          actions={<Pick label="" value={asset.id} options={assets.map((a) => ({ value: a.id, label: a.name }))} onChange={(id) => select({ selectedAssetId: id })} />}
        >
          <Waveform pcm={pcm} selection={selection} onSelect={setSelection} />
          <p className="hint">{selection && selection.end - selection.start > 0.1 ? `Analysing ${fmt(selection.start)} – ${fmt(selection.end)}` : 'Analysing the whole file (drag to restrict to a region).'}</p>
          <Row>
            <Pick
              label="Engine"
              value={engine}
              options={[
                { value: 'poly', label: 'Polyphonic — Basic Pitch (neural)' },
                { value: 'mono', label: 'Monophonic — YIN (vocals / speech / lead)' },
              ]}
              onChange={setEngine}
            />
            {engine === 'poly' && (
              <>
                <Num label="Onset threshold" value={onsetT} step={0.05} min={0.05} max={0.95} onChange={setOnsetT} />
                <Num label="Frame threshold" value={frameT} step={0.05} min={0.05} max={0.95} onChange={setFrameT} />
              </>
            )}
            <Num label="Min Hz (0 = any)" value={minHz} step={10} onChange={setMinHz} />
            <Num label="Max Hz (0 = any)" value={maxHz} step={10} onChange={setMaxHz} />
          </Row>
          <Row>
            <Num label="Split into voices" value={voices} step={1} min={1} max={8} onChange={(v) => setVoices(Math.max(1, Math.round(v)))} />
            <Check label="Top melody only" value={melodyOnly} onChange={setMelodyOnly} />
            <button className="primary" disabled={!pcm} onClick={run}>
              Extract MIDI
            </button>
            <button
              disabled={!pcm}
              onClick={() => {
                if (!pcm) return;
                const region = selection && selection.end - selection.start > 1 ? slice(pcm, selection.start, selection.end) : pcm;
                const { bpm, confidence } = estimateTempo(detectOnsets(region));
                if (confirm(`Estimated tempo ${bpm.toFixed(1)} BPM (confidence ${(confidence * 100).toFixed(0)}%). Use it for the project?`))
                  update((p) => void (p.bpm = Math.round(bpm * 10) / 10));
              }}
            >
              Estimate BPM
            </button>
          </Row>
          {progress > 0 && progress < 1 && <progress value={progress} max={1} />}
        </Section>
      )}
      {result && (
        <div className="notice">
          {result} <button onClick={() => setTab('midi')}>Open MIDI editor →</button>
        </div>
      )}
    </div>
  );
}
