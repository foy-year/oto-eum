import { useEffect, useState } from 'react';
import { job, media, useStore } from '../store';
import { Row, Section, fmt } from '../widgets';
import { type Pcm, slice } from '../../core/audio/pcm';
import { findSyllables, type SyllableCandidate } from '../../core/analysis/sampleFinder';
import { midiToName } from '../../core/analysis/pitch';
import { createSample } from '../../core/project';
import { prepareSample, renderTrack } from '../../core/render/sampler';
import { openVideoPixels } from '../../core/video/frameStream';
import type { MediaAsset } from '../../core/types';
import { play } from '../player';

/** Thumbnails for candidate times (video sources). */
async function thumbs(asset: MediaAsset, times: number[]): Promise<string[]> {
  const vp = await openVideoPixels(await media.getBlob(asset.id), 160);
  try {
    const c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    const g = c.getContext('2d')!;
    const out: string[] = [];
    for (const t of times) {
      const f = await vp.frameAt(t);
      if (!f) {
        out.push('');
        continue;
      }
      const img = g.createImageData(f.width, f.height);
      img.data.set(f.data);
      g.putImageData(img, 0, 0);
      out.push(c.toDataURL('image/jpeg', 0.7));
    }
    return out;
  } finally {
    vp.dispose();
  }
}

/** Ranked pitched syllables in the current source, one click to turn into samples. */
export function SampleFinder({ asset, pcm, onRegions }: { asset: MediaAsset; pcm: Pcm | null; onRegions: (r: { start: number; end: number }[]) => void }) {
  const { addSample } = useStore();
  const [found, setFound] = useState<SyllableCandidate[]>([]);
  const [pics, setPics] = useState<string[]>([]);
  useEffect(() => {
    setFound([]);
    setPics([]);
    onRegions([]);
  }, [asset.id]);

  const run = () =>
    job('Looking for pitched syllables…', async () => {
      if (!pcm) return;
      await new Promise((r) => setTimeout(r, 30));
      const c = findSyllables(pcm, { limit: 24 });
      setFound(c);
      onRegions(c.map((x) => ({ start: x.start, end: x.end })));
      setPics(asset.kind === 'video' ? await thumbs(asset, c.map((x) => (x.steadyStart + x.steadyEnd) / 2)) : []);
    });

  const use = (c: SyllableCandidate, kind: 'oneshot' | 'loop') => {
    const root = c.rootMidi;
    addSample(
      createSample(asset.id, kind === 'loop' ? c.steadyStart : c.start, kind === 'loop' ? c.steadyEnd : c.end, {
        name: `${midiToName(root)} ${kind === 'loop' ? 'loop' : 'syllable'} @${c.start.toFixed(2)}`,
        rootPitch: Math.round(root),
        rootCents: Math.round((root - Math.round(root)) * 100),
        pitchMode: 'resample',
        sustain: kind === 'loop' ? 'loop' : 'cut',
        fadeIn: kind === 'loop' ? 0.004 : 0.002,
        fadeOut: kind === 'loop' ? 0.004 : 0.01,
      }),
    );
  };

  const audition = (c: SyllableCandidate, loop: boolean) => {
    if (!pcm) return;
    if (!loop) return play(slice(pcm, c.start, c.end));
    const s = createSample(asset.id, c.steadyStart, c.steadyEnd, { rootPitch: Math.round(c.rootMidi), sustain: 'loop', fadeIn: 0.004, fadeOut: 0.004 });
    const clip = prepareSample(pcm, s, pcm.sampleRate);
    play(renderTrack([{ id: 'a', pitch: Math.round(c.rootMidi), start: 0, duration: 0.8, velocity: 1 }], clip, s, { sampleRate: pcm.sampleRate }));
  };

  return (
    <Section title="Find samples" actions={<button className="primary" disabled={!pcm} onClick={run}>Find pitched syllables</button>}>
      {!found.length && <p className="hint">Scans the source for syllables with a clear, steady pitch (good 音MAD material) and ranks them. Found ones are marked on the waveform.</p>}
      {found.length > 0 && (
        <div className="finder">
          {found.map((c, i) => (
            <div key={i} className="cand">
              {pics[i] ? <img src={pics[i]} alt="" /> : <div className="noimg" />}
              <div>
                <b>{midiToName(c.rootMidi)}</b> <span className="hint">{((c.rootMidi - Math.round(c.rootMidi)) * 100).toFixed(0)}¢</span>
                <div className="hint">
                  {fmt(c.start)} · {(c.end - c.start).toFixed(2)} s
                </div>
                <div className="meter" title={`steadiness (pitch spread ${c.spread.toFixed(2)} st)`}>
                  <span style={{ width: `${Math.round(c.score * 100)}%` }} />
                </div>
              </div>
              <Row>
                <button onClick={() => audition(c, false)} title="Play the syllable">▶</button>
                <button onClick={() => audition(c, true)} title="Play the steady vowel looped">▶ loop</button>
                <button onClick={() => use(c, 'oneshot')}>+ one-shot</button>
                <button onClick={() => use(c, 'loop')}>+ loop</button>
              </Row>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
