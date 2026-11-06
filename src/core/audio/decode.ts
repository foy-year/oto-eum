/** Browser-side media probing & decoding (audio from mp3/wav/ogg/m4a/mp4/webm/mov...). */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { type Pcm, createPcm, fromAudioBuffer, mixInto } from './pcm';
import type { MediaAsset } from '../types';

export interface ProbeResult {
  kind: 'audio' | 'video';
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
}

export async function probeMedia(blob: Blob): Promise<ProbeResult> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const [v, a] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    const duration = await input.computeDuration();
    if (v) {
      const stats = await v.computePacketStats(120).catch(() => null);
      return { kind: 'video', duration, width: await v.getDisplayWidth(), height: await v.getDisplayHeight(), fps: stats?.averagePacketRate, hasAudio: !!a };
    }
    return { kind: 'audio', duration, hasAudio: !!a };
  } catch {
    // Fallback: let Web Audio try (e.g. formats Mediabunny can't demux)
    const pcm = await decodeWithWebAudio(blob);
    return { kind: 'audio', duration: pcm.channels[0].length / pcm.sampleRate, hasAudio: true };
  } finally {
    input.dispose();
  }
}

let ctx: AudioContext | null = null;
async function decodeWithWebAudio(blob: Blob): Promise<Pcm> {
  ctx ??= new AudioContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return fromAudioBuffer(buf);
}

async function decodeWithMediabunny(blob: Blob): Promise<Pcm | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const sr = await track.getSampleRate();
    const ch = await track.getNumberOfChannels();
    let out = createPcm(sr, Math.min(2, ch), 0);
    const first = (await track.getFirstTimestamp()) ?? 0;
    for await (const w of new AudioBufferSink(track).buffers()) {
      out = mixInto(out, fromAudioBuffer(w.buffer), Math.max(0, w.timestamp - first));
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** Decode the audio track of any supported file to PCM. */
export async function decodeAudio(blob: Blob): Promise<Pcm> {
  try {
    return await decodeWithWebAudio(blob);
  } catch (e) {
    const p = await decodeWithMediabunny(blob);
    if (p) return p;
    throw new Error(`Could not decode audio: ${(e as Error).message}`);
  }
}

export function assetFromProbe(id: string, file: File | Blob, name: string, p: ProbeResult): MediaAsset {
  return {
    id,
    name,
    kind: p.kind,
    mime: file.type || (p.kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
    size: file.size,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    createdAt: Date.now(),
  };
}
