import { type Pcm, toAudioBuffer, durationOf } from '../core/audio/pcm';

let ctx: AudioContext | null = null;
let current: { src: AudioBufferSourceNode; startedAt: number; offset: number; duration: number } | null = null;
const listeners = new Set<() => void>();

export function audioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

export function play(pcm: Pcm, offset = 0): void {
  stop();
  const c = audioContext();
  void c.resume();
  const src = c.createBufferSource();
  src.buffer = toAudioBuffer(pcm);
  src.connect(c.destination);
  const startedAt = c.currentTime + 0.05;
  src.start(startedAt, Math.max(0, offset));
  current = { src, startedAt, offset, duration: durationOf(pcm) };
  src.onended = () => {
    if (current?.src === src) current = null;
    listeners.forEach((l) => l());
  };
  listeners.forEach((l) => l());
}

export function stop(): void {
  if (current) {
    try {
      current.src.stop();
    } catch {
      /* already stopped */
    }
    current = null;
    listeners.forEach((l) => l());
  }
}

/** Playhead position in seconds of the currently playing buffer, or null. */
export function position(): number | null {
  if (!current || !ctx) return null;
  const t = current.offset + (ctx.currentTime - current.startedAt);
  return t > current.duration ? null : Math.max(current.offset, t);
}

export function isPlaying() {
  return current != null;
}

export function onPlayerChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
