/**
 * Browser side of the recipe: project.json + source video + mix.wav → MP4,
 * using the toolkit's video sync (incl. scenes) + WebCodecs exporter. Driven by render.mjs.
 */
import { decodeWav } from '../../src/core/audio/wav';
import { projectVideoEvents } from '../../src/core/video/timeline';
import { MediaFrameProvider } from '../../src/core/video/frames';
import { exportVideo } from '../../src/core/video/export';
import type { MediaAsset, Project } from '../../src/core/types';

type Meta = { firstBar: number; songEnd: number; outroStart: number; total: number };

async function run() {
  const { project, meta } = (await (await fetch('/otomad/project.json')).json()) as { project: Project; meta: Meta };
  const video = await (await fetch('/otomad/source.mp4')).blob();
  const mix = decodeWav(new Uint8Array(await (await fetch('/otomad/mix.wav')).arrayBuffer()));
  const asset: MediaAsset = { id: 'ad', name: 'ad', kind: 'video', mime: 'video/mp4', size: video.size, duration: 23, createdAt: 0 };
  // scenes, layouts and the outro clip all come from the project (core: projectVideoEvents → applyScenes)
  const events = projectVideoEvents(project, [asset], meta.outroStart);

  const frames = new MediaFrameProvider(async () => video, { maxWidth: 640, maxHeight: 360, capacity: 2000 });
  const t0 = performance.now();
  const res = await exportVideo({
    events,
    settings: project.videoSync,
    audio: mix,
    duration: meta.total,
    frames,
    prefer: 'mp4',
    onProgress: (f) => ((document.title = `render ${(f * 100).toFixed(0)}%`), void 0),
  });
  await fetch('/otomad/upload', { method: 'POST', body: res.blob });
  return { ms: performance.now() - t0, codec: `${res.videoCodec}/${res.audioCodec}`, size: res.blob.size, events: events.length };
}

(window as unknown as { renderOtomad: typeof run }).renderOtomad = run;
document.title = 'ready';
