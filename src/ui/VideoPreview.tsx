import { useEffect, useRef, useState } from 'react';
import type { VideoEvent, VideoSyncSettings } from '../core/types';
import { drawFrame, prepareRange } from '../core/video/compositor';
import { MediaFrameProvider } from '../core/video/frames';
import { exportVideo } from '../core/video/export';
import { type Pcm, durationOf } from '../core/audio/pcm';
import { download, job, media } from './store';
import { play, stop, position } from './player';
import { Row, fmt } from './widgets';

let shared: MediaFrameProvider | null = null;
/** One frame cache for the whole app (preview), sized for preview resolution. */
export function previewFrames(): MediaFrameProvider {
  shared ??= new MediaFrameProvider((id) => media.getBlob(id), { maxWidth: 640, maxHeight: 360, capacity: 1500 });
  return shared;
}

/**
 * Canvas preview of a list of VideoEvents, synchronised to the audio clock,
 * plus frame-exact export.
 */
export function VideoPreview(props: { events: VideoEvent[]; settings: VideoSyncSettings; getAudio: () => Promise<Pcm | null>; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const abort = useRef<AbortController | null>(null);
  const duration = Math.max(0.1, ...props.events.map((e) => e.end));
  const { width, height } = props.settings;
  const previewW = 640;
  const previewH = Math.round((previewW * height) / width);

  const draw = (time: number) => {
    const c = canvas.current;
    if (!c) return 0;
    return drawFrame(c.getContext('2d')!, props.events, time, previewFrames(), props.settings);
  };

  // still-frame preview when scrubbing
  useEffect(() => {
    if (playing) return;
    let cancelled = false;
    const f = previewFrames();
    void prepareRange(props.events, f, t, t + 1 / props.settings.fps, props.settings.fps).then(() => !cancelled && draw(t));
    draw(t);
    return () => {
      cancelled = true;
    };
  }, [t, props.events, props.settings, playing]);

  // playback loop: audio clock drives the picture; decode ahead in 2 s chunks
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let ahead = t;
    let decoding = false;
    const f = previewFrames();
    const loop = () => {
      const pos = position();
      if (pos == null) {
        setPlaying(false);
        return;
      }
      if (!decoding && ahead < pos + 4 && ahead < duration) {
        decoding = true;
        const a = Math.max(ahead, pos);
        void prepareRange(props.events, f, a, a + 2, props.settings.fps).finally(() => {
          ahead = a + 2;
          decoding = false;
        });
      }
      draw(pos);
      setT(pos);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const start = () =>
    job('Preparing preview…', async () => {
      const f = previewFrames();
      await prepareRange(props.events, f, t, Math.min(duration, t + 3), props.settings.fps);
      const audio = await props.getAudio();
      if (audio) play(audio, t);
      setPlaying(true);
    });

  return (
    <div className="video-preview">
      <canvas ref={canvas} width={previewW} height={previewH} style={{ aspectRatio: `${width}/${height}` }} />
      <input type="range" className="hscroll" min={0} max={duration} step={1 / props.settings.fps} value={t} onChange={(e) => setT(+e.target.value)} disabled={playing} />
      <Row>
        {!playing ? <button className="primary" onClick={start}>▶ Play</button> : <button onClick={() => (stop(), setPlaying(false))}>■ Stop</button>}
        <span className="hint">
          {fmt(t)} / {fmt(duration)} · {props.events.length} video events
        </span>
        <span className="sep" />
        <button
          onClick={() =>
            job('Exporting video… (frame-exact, may take a while)', async () => {
              abort.current = new AbortController();
              setStatus('');
              const audio = await props.getAudio();
              const frames = new MediaFrameProvider((id) => media.getBlob(id), { maxWidth: width, maxHeight: height, capacity: 600 });
              try {
                const res = await exportVideo({
                  events: props.events,
                  settings: props.settings,
                  audio: audio ?? undefined,
                  duration: Math.max(duration, audio ? durationOf(audio) : 0),
                  frames,
                  onProgress: setProgress,
                  signal: abort.current.signal,
                });
                download(res.blob, `${props.name}.${res.extension}`, res.mime);
                setStatus(`Exported ${res.extension.toUpperCase()} (${res.videoCodec}${res.audioCodec ? ' + ' + res.audioCodec : ''}), ${(res.blob.size / 1e6).toFixed(1)} MB`);
              } finally {
                frames.dispose();
                setProgress(0);
              }
            })
          }
        >
          Export video ({width}×{height} @ {props.settings.fps} fps)
        </button>
        {progress > 0 && (
          <>
            <progress value={progress} max={1} />
            <button onClick={() => abort.current?.abort()}>Cancel</button>
          </>
        )}
        <span className="hint">{status}</span>
      </Row>
    </div>
  );
}
