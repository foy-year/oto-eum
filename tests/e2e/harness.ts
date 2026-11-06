/**
 * Exposes the real browser pipeline to Playwright: decode → transcribe →
 * sample → mix → sync → WebCodecs export → re-decode and inspect pixels.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { probeMedia, decodeAudio } from '../../src/core/audio/decode';
import { transcribe } from '../../src/core/midi/transcribe';
import { createProject, createSample, createTrack } from '../../src/core/project';
import { mixProject } from '../../src/core/render/mix';
import { projectVideoEvents } from '../../src/core/video/timeline';
import { MediaFrameProvider } from '../../src/core/video/frames';
import { exportVideo } from '../../src/core/video/export';
import { durationOf, slice } from '../../src/core/audio/pcm';
import { detectRootPitch } from '../../src/core/analysis/pitch';
import type { MediaAsset } from '../../src/core/types';

const fetchBlob = async (name: string) => {
  const r = await fetch(`/tests/fixtures/${name}`);
  return new Blob([await r.arrayBuffer()], { type: r.headers.get('content-type') ?? '' });
};

async function pixelAt(blob: Blob, t: number): Promise<[number, number, number]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const sink = new CanvasSink(track, { width: 64, height: 48, fit: 'fill' });
  const wc = (await sink.getCanvas(t))!;
  const ctx = (wc.canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
  const d = ctx.getImageData(32, 24, 1, 1).data;
  input.dispose();
  return [d[0], d[1], d[2]];
}

const api = {
  async codecs() {
    return {
      videoEncoder: typeof VideoEncoder !== 'undefined',
      h264: typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 320, height: 240 })).supported,
      vp9: typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported({ codec: 'vp09.00.10.08', width: 320, height: 240 })).supported,
    };
  },

  async probe(name: string) {
    return probeMedia(await fetchBlob(name));
  },

  async decode(name: string) {
    const pcm = await decodeAudio(await fetchBlob(name));
    const root = detectRootPitch(slice(pcm, 0.5, 1.5));
    return { duration: durationOf(pcm), sampleRate: pcm.sampleRate, channels: pcm.channels.length, rootMidi: root?.midi };
  },

  async transcribe(name: string, engine: 'mono' | 'poly') {
    const pcm = await decodeAudio(await fetchBlob(name));
    const t0 = performance.now();
    const notes = await transcribe(pcm, { engine });
    return { ms: performance.now() - t0, notes: notes.map((n) => ({ pitch: Math.round(n.pitch), start: +n.start.toFixed(3), duration: +n.duration.toFixed(3) })) };
  },

  /** Full 音MAD pipeline with a colour-coded source video to verify sync. */
  async pipeline(videoName: string, prefer: 'mp4' | 'webm') {
    const blob = await fetchBlob(videoName);
    const probe = await probeMedia(blob);
    const asset: MediaAsset = { id: 'vid', name: videoName, kind: probe.kind, mime: blob.type, size: blob.size, duration: probe.duration, fps: probe.fps, createdAt: 0 };
    const project = createProject('e2e');
    project.videoSync = { ...project.videoSync, width: 320, height: 240, fps: 30, layout: 'single', alternateFlip: false, punch: 1, flash: 0, holdLastFrame: true };
    const sample = createSample('vid', 0, 4, { rootPitch: 60, sustain: 'cut' });
    project.samples.push(sample);
    // note 1: an octave up (2x speed) for 2 s; note 2: original speed from t=2
    project.tracks.push(createTrack('lead', { sampleId: sample.id, notes: [{ id: 'a', pitch: 72, start: 0, duration: 2, velocity: 1 }, { id: 'b', pitch: 60, start: 2, duration: 1.5, velocity: 1 }] }));
    const srcPcm = await decodeAudio(blob);
    const { master } = await mixProject(project, async () => srcPcm);
    const events = projectVideoEvents(project, [asset], 3.5);
    const frames = new MediaFrameProvider(async () => blob, { maxWidth: 320, maxHeight: 240 });
    const t0 = performance.now();
    const res = await exportVideo({ events, settings: project.videoSync, audio: master, duration: 3.5, frames, prefer });
    const ms = performance.now() - t0;
    frames.dispose();
    const outProbe = await probeMedia(res.blob);
    const outAudio = await decodeAudio(res.blob).catch(() => null);
    // expected source colours: t=0.25→src 0.5 red, 0.75→1.5 lime, 1.25→2.5 blue, 1.75→3.5 white, 2.5→src 0.5 red, 3.2→1.2 lime
    const probes = [0.25, 0.75, 1.25, 1.75, 2.5, 3.2];
    const pixels: [number, number, number][] = [];
    for (const t of probes) pixels.push(await pixelAt(res.blob, t));
    return {
      ms,
      extension: res.extension,
      videoCodec: res.videoCodec,
      audioCodec: res.audioCodec,
      size: res.blob.size,
      outDuration: outProbe.duration,
      outHasAudio: outProbe.hasAudio,
      outAudioPitchFirstNote: outAudio ? detectRootPitch(slice(outAudio, 0.3, 0.8))?.midi : null,
      pixels: probes.map((t, i) => ({ t, rgb: pixels[i] })),
    };
  },
};

(window as unknown as { oto: typeof api }).oto = api;
document.title = 'ready';
