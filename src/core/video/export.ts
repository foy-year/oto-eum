/**
 * Offline (faster-than-realtime, frame-exact) video export via WebCodecs +
 * Mediabunny. Produces MP4 (H.264/AAC) when the browser can encode it, else
 * WebM (VP9/VP8 + Opus).
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { type Pcm, durationOf, slice, toAudioBuffer } from '../audio/pcm';
import type { VideoEvent, VideoSyncSettings } from '../types';
import { drawFrame, prepareRange } from './compositor';
import type { FrameProvider } from './frames';

export interface ExportOptions {
  events: VideoEvent[];
  settings: VideoSyncSettings;
  audio?: Pcm;
  duration?: number;
  frames: FrameProvider & { open?: (id: string) => Promise<unknown> };
  /** Seconds decoded per batch — bounds memory use. */
  chunk?: number;
  prefer?: 'mp4' | 'webm';
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  extension: 'mp4' | 'webm';
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
}

async function pickFormat(prefer: 'mp4' | 'webm', w: number, h: number, fps: number, withAudio: boolean) {
  const candidates =
    prefer === 'mp4'
      ? [
          { ext: 'mp4' as const, v: ['avc', 'hevc', 'vp9', 'av1'] as VideoCodec[], a: ['aac', 'opus'] as AudioCodec[] },
          { ext: 'webm' as const, v: ['vp9', 'vp8', 'av1'] as VideoCodec[], a: ['opus', 'vorbis'] as AudioCodec[] },
        ]
      : [
          { ext: 'webm' as const, v: ['vp9', 'vp8', 'av1'] as VideoCodec[], a: ['opus', 'vorbis'] as AudioCodec[] },
          { ext: 'mp4' as const, v: ['avc', 'hevc', 'vp9', 'av1'] as VideoCodec[], a: ['aac', 'opus'] as AudioCodec[] },
        ];
  for (const c of candidates) {
    const v = await getFirstEncodableVideoCodec(c.v, { width: w, height: h, frameRate: fps });
    if (!v) continue;
    const a = withAudio ? await getFirstEncodableAudioCodec(c.a, { numberOfChannels: 2, sampleRate: 48000 }) : null;
    if (withAudio && !a) continue;
    return { ext: c.ext, v, a };
  }
  throw new Error('This browser cannot encode video (WebCodecs VideoEncoder unavailable).');
}

export async function exportVideo(o: ExportOptions): Promise<ExportResult> {
  const { width, height, fps } = o.settings;
  const W = width - (width % 2);
  const H = height - (height % 2);
  const duration = o.duration ?? Math.max(o.audio ? durationOf(o.audio) : 0, ...o.events.map((e) => e.end), 0.1);
  const fmt = await pickFormat(o.prefer ?? 'mp4', W, H, fps, !!o.audio);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({
    format: fmt.ext === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: fmt.v, quality: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource: AudioBufferSource | null = null;
  if (o.audio && fmt.a) {
    audioSource = new AudioBufferSource({ codec: fmt.a, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const total = Math.ceil(duration * fps);
  const chunk = o.chunk ?? 4;
  let audioPos = 0;
  for (let c0 = 0; c0 < duration; c0 += chunk) {
    if (o.signal?.aborted) {
      await output.cancel();
      throw new DOMException('Export aborted', 'AbortError');
    }
    const c1 = Math.min(duration, c0 + chunk);
    await prepareRange(o.events, o.frames, c0, c1, fps);
    for (let f = Math.ceil(c0 * fps); f < Math.ceil(c1 * fps) && f < total; f++) {
      const t = f / fps;
      drawFrame(ctx, o.events, t, o.frames, o.settings);
      await videoSource.add(t, 1 / fps);
      o.onProgress?.(f / total);
    }
    // interleave audio so the muxer doesn't buffer the whole file
    if (audioSource && o.audio) {
      const end = Math.min(durationOf(o.audio), c1);
      if (end > audioPos) {
        await audioSource.add(toAudioBuffer(slice(o.audio, audioPos, end)));
        audioPos = end;
      }
    }
  }
  if (audioSource && o.audio && audioPos < durationOf(o.audio) && audioPos < duration) {
    await audioSource.add(toAudioBuffer(slice(o.audio, audioPos, duration)));
  }
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  const mime = fmt.ext === 'mp4' ? 'video/mp4' : 'video/webm';
  o.onProgress?.(1);
  return { blob: new Blob([buf], { type: mime }), mime, extension: fmt.ext, videoCodec: fmt.v, audioCodec: fmt.a };
}
