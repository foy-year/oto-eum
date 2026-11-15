/**
 * Browser side of the recipe: project.json + source video + mix.wav → MP4,
 * using the toolkit's video sync + WebCodecs exporter. Driven by render.mjs.
 */
import { decodeWav } from '../../src/core/audio/wav';
import { projectVideoEvents, sourceTimeAt, layoutRects } from '../../src/core/video/timeline';
import { MediaFrameProvider } from '../../src/core/video/frames';
import { exportVideo } from '../../src/core/video/export';
import type { MediaAsset, Project, Rect, VideoEvent } from '../../src/core/types';

type Meta = { firstBar: number; songEnd: number; outroStart: number; total: number };

/** Scene layouts: which rect each video track gets from a given time on. */
function scenes(project: Project, meta: Meta, wildStart: number) {
  const ids = project.videoTrackIds!; // [main, harmony, wild, bass, chorus, arp]
  const [main, harmony, wild, bass, chorus, arp] = ids;
  const L = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  const grid6 = layoutRects('grid', 6);
  return [
    { from: 0, rects: { [main]: L(0, 0, 0.5, 1), [bass]: L(0.5, 0, 0.5, 1) } },
    { from: meta.firstBar, rects: { [main]: L(0, 0, 0.5, 1), [harmony]: L(0.5, 0, 0.25, 0.5), [chorus]: L(0.75, 0, 0.25, 0.5), [bass]: L(0.5, 0.5, 0.25, 0.5), [arp]: L(0.75, 0.5, 0.25, 0.5) } },
    { from: wildStart, rects: { [main]: grid6[0], [harmony]: grid6[1], [wild]: grid6[2], [bass]: grid6[3], [chorus]: grid6[4], [arp]: grid6[5] } },
  ];
}

async function run() {
  const { project, meta } = (await (await fetch('/otomad/project.json')).json()) as { project: Project; meta: Meta };
  const video = await (await fetch('/otomad/source.mp4')).blob();
  const mix = decodeWav(new Uint8Array(await (await fetch('/otomad/mix.wav')).arrayBuffer()));
  const asset: MediaAsset = { id: 'ad', name: 'ad', kind: 'video', mime: 'video/mp4', size: video.size, duration: 23, createdAt: 0 };

  const base = projectVideoEvents(project, [asset], meta.outroStart);
  const trackOf = new Map<VideoEvent, string>();
  // projectVideoEvents keeps track order; recover the track of each synced event by its layer
  const vids = project.videoTrackIds!;
  const synced = base.filter((e) => e.layer < 1000);
  synced.forEach((e) => trackOf.set(e, vids[e.layer]));
  const wildId = vids[2];
  const wildStart = Math.min(...project.tracks.find((t) => t.id === wildId)!.notes.map((n) => n.start));
  const sc = scenes(project, meta, wildStart);

  // split events at scene boundaries, give each piece its scene's rect, cut everything at the outro
  const events: VideoEvent[] = [];
  for (const e of synced) {
    const id = trackOf.get(e)!;
    const cuts = [e.start, ...sc.map((s) => s.from).filter((t) => t > e.start && t < e.end), Math.min(e.end, meta.outroStart)];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      if (b <= a) continue;
      const scene = [...sc].reverse().find((s) => s.from <= a + 1e-6)!;
      const rect = scene.rects[id];
      if (!rect) continue;
      const first = i === 0;
      const sIn = first ? e.sourceIn : sourceTimeAt(e, a)!;
      events.push({ ...e, start: a, end: b, sourceIn: sIn, rect, punch: first ? e.punch : 1, flash: first ? e.flash : 0 });
    }
  }
  events.push(...base.filter((e) => e.layer >= 1000));

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
