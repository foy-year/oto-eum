import { decodeAudio } from '../../src/core/audio/decode';
import { slice, rms, toMono, resample } from '../../src/core/audio/pcm';
import { encodeWav } from '../../src/core/audio/wav';
import { HTDemucs, separateStems } from '../../src/core/analysis/demucs';
import { separateVoice } from '../../src/core/analysis/separate';

const api = {
  async run(seconds: number) {
    const src = await decodeAudio(await (await fetch('/sep/source.mp4')).blob());
    const clip = slice(src, 0, seconds);
    console.log('decoded', clip.channels[0].length);
    const t0 = performance.now();
    const model = await HTDemucs.load(new Uint8Array(await (await fetch('/_local/htdemucs.onnx')).arrayBuffer()), undefined, new URLSearchParams(location.search).get('gpu') !== '0');
    const tLoad = performance.now() - t0;
    console.log('session ready', model.backend, Math.round(tLoad));
    const stems = await separateStems(model, clip, (f) => console.log('progress', f.toFixed(2)));
    const tSep = performance.now() - t0 - tLoad;
    const r = (p: typeof clip, a: number, b: number) => rms(toMono(slice(p, a, b)));
    const n = clip.channels[0].length;
    let err = 0, tot = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i += 7) {
      const s = stems.drums.channels[c][i] + stems.bass.channels[c][i] + stems.other.channels[c][i] + stems.vocals.channels[c][i];
      err += (s - clip.channels[c][i]) ** 2;
      tot += clip.channels[c][i] ** 2;
    }
    const nanReport: Record<string, string> = {};
    for (const [k, p] of Object.entries(stems)) {
      const c = p.channels[0];
      let first = -1, count = 0;
      p.channels.forEach((ch, ci) => {
        for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) { count++; if (first < 0) { first = i; console.log('non-finite', k, 'ch', ci, 'at', (i / p.sampleRate).toFixed(3), ch[i], 'len', ch.length); } }
      });
      const peaks: string[] = [];
      for (let t = 0; t < seconds; t++) {
        let m = 0;
        for (let i = t * p.sampleRate; i < Math.min(c.length, (t + 1) * p.sampleRate); i++) m = Math.max(m, Math.abs(c[i]));
        peaks.push(m.toExponential(1));
      }
      nanReport[k] = `${count} NaN; peak per second: ${peaks.join(' ')}`;
    }
    for (const [k, v] of Object.entries(nanReport)) console.log('stem', k, v);
    if (new URLSearchParams(location.search).get('export') === '1')
      await fetch('/sep/upload', { method: 'POST', body: encodeWav(resample(stems.vocals, 48000)) as Uint8Array<ArrayBuffer> });
    const builtIn = separateVoice(clip);
    return {
      backend: model.backend,
      loadMs: Math.round(tLoad),
      sepMs: Math.round(tSep),
      sumErrorDb: 10 * Math.log10(err / tot),
      vocalsMusicPart: r(stems.vocals, 0.3, 3.8),
      vocalsSpeechPart: r(stems.vocals, 4.3, seconds),
      mixMusicPart: r(clip, 0.3, 3.8),
      mixSpeechPart: r(clip, 4.3, seconds),
      builtInVocalsMusicPart: r(builtIn.vocals, 0.3, 3.8),
      builtInVocalsSpeechPart: r(builtIn.vocals, 4.3, seconds),
    };
  },
};
(window as unknown as { sep: typeof api }).sep = api;
document.title = 'ready';
