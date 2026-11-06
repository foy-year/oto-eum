/**
 * Minimal planar PCM container + pure DSP helpers.
 *
 * We deliberately avoid depending on the Web Audio `AudioBuffer` in the core so
 * that every algorithm can run in Node (tests), Web Workers, and the browser.
 * Use `toAudioBuffer` / `fromAudioBuffer` at the edges.
 */

export interface Pcm {
  sampleRate: number;
  /** Planar channel data, all channels have identical length. */
  channels: Float32Array[];
}

export const lengthOf = (pcm: Pcm) => (pcm.channels[0]?.length ?? 0);
export const durationOf = (pcm: Pcm) => lengthOf(pcm) / pcm.sampleRate;

export function createPcm(sampleRate: number, numChannels: number, length: number): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(Math.max(0, Math.round(length))));
  return { sampleRate, channels };
}

export function clonePcm(pcm: Pcm): Pcm {
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => new Float32Array(c)) };
}

export function fromAudioBuffer(buf: AudioBuffer): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(new Float32Array(buf.getChannelData(c)));
  return { sampleRate: buf.sampleRate, channels };
}

export function toAudioBuffer(pcm: Pcm): AudioBuffer {
  const len = Math.max(1, lengthOf(pcm));
  const buf = new AudioBuffer({ length: len, numberOfChannels: Math.max(1, pcm.channels.length), sampleRate: pcm.sampleRate });
  pcm.channels.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  return buf;
}

export function toMono(pcm: Pcm): Float32Array {
  const n = lengthOf(pcm);
  if (pcm.channels.length === 1) return pcm.channels[0];
  const out = new Float32Array(n);
  const k = 1 / pcm.channels.length;
  for (const ch of pcm.channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

/** Return a copy with exactly `n` channels (duplicating or down-mixing). */
export function withChannels(pcm: Pcm, n: number): Pcm {
  if (pcm.channels.length === n) return pcm;
  if (n === 1) return { sampleRate: pcm.sampleRate, channels: [toMono(pcm)] };
  const channels: Float32Array[] = [];
  for (let c = 0; c < n; c++) channels.push(new Float32Array(pcm.channels[Math.min(c, pcm.channels.length - 1)]));
  return { sampleRate: pcm.sampleRate, channels };
}

/** Copy the [start, end) region in seconds. */
export function slice(pcm: Pcm, start: number, end: number): Pcm {
  const n = lengthOf(pcm);
  const a = clampInt(Math.round(start * pcm.sampleRate), 0, n);
  const b = clampInt(Math.round(end * pcm.sampleRate), a, n);
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice(a, b)) };
}

export function reverse(pcm: Pcm): Pcm {
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice().reverse()) };
}

export function applyGain(pcm: Pcm, gain: number): Pcm {
  if (gain === 1) return pcm;
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.map((v) => v * gain)) };
}

export function peak(pcm: Pcm): number {
  let p = 0;
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  from = Math.max(0, Math.floor(from));
  to = Math.min(samples.length, Math.floor(to));
  let s = 0;
  for (let i = from; i < to; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function normalize(pcm: Pcm, targetPeak = 0.98): Pcm {
  const p = peak(pcm);
  return p > 1e-9 ? applyGain(pcm, targetPeak / p) : pcm;
}

/** Linear fades, in seconds. Mutates a copy. */
export function fade(pcm: Pcm, fadeIn: number, fadeOut: number): Pcm {
  const out = clonePcm(pcm);
  const n = lengthOf(out);
  const fi = Math.min(n, Math.round(fadeIn * pcm.sampleRate));
  const fo = Math.min(n, Math.round(fadeOut * pcm.sampleRate));
  for (const ch of out.channels) {
    for (let i = 0; i < fi; i++) ch[i] *= i / fi;
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= i / fo;
  }
  return out;
}

/** Remove leading/trailing audio below `threshold` (linear). */
export function trimSilence(pcm: Pcm, threshold = 0.01): Pcm {
  const mono = toMono(pcm);
  let a = 0;
  let b = mono.length;
  while (a < b && Math.abs(mono[a]) < threshold) a++;
  while (b > a && Math.abs(mono[b - 1]) < threshold) b--;
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.slice(a, b)) };
}

/** Linear-interpolating resampler. Good enough for analysis + preview paths. */
export function resample(pcm: Pcm, targetRate: number): Pcm {
  if (pcm.sampleRate === targetRate) return pcm;
  const ratio = pcm.sampleRate / targetRate;
  const outLen = Math.floor(lengthOf(pcm) / ratio);
  const channels = pcm.channels.map((src) => {
    const out = new Float32Array(outLen);
    // Simple anti-alias pre-filter when down-sampling.
    const s = ratio > 1 ? boxLowpass(src, Math.ceil(ratio)) : src;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const f = pos - i0;
      const a = s[i0] ?? 0;
      const b = s[i0 + 1] ?? a;
      out[i] = a + (b - a) * f;
    }
    return out;
  });
  return { sampleRate: targetRate, channels };
}

function boxLowpass(src: Float32Array, width: number): Float32Array {
  if (width <= 1) return src;
  const out = new Float32Array(src.length);
  let acc = 0;
  for (let i = 0; i < src.length; i++) {
    acc += src[i];
    if (i >= width) acc -= src[i - width];
    out[i] = acc / Math.min(i + 1, width);
  }
  // compensate the half-window delay
  const shift = Math.floor(width / 2);
  return out.copyWithin(0, shift).fill(out[out.length - 1] ?? 0, out.length - shift);
}

/** Mix `src` into `dst` at `offsetSeconds` (in place on dst, which grows if needed). */
export function mixInto(dst: Pcm, src: Pcm, offsetSeconds: number, gain = 1): Pcm {
  if (src.sampleRate !== dst.sampleRate) src = resample(src, dst.sampleRate);
  const off = Math.round(offsetSeconds * dst.sampleRate);
  const need = off + lengthOf(src);
  if (need > lengthOf(dst)) {
    dst = {
      sampleRate: dst.sampleRate,
      channels: dst.channels.map((c) => {
        const g = new Float32Array(need);
        g.set(c);
        return g;
      }),
    };
  }
  const srcN = withChannels(src, dst.channels.length);
  for (let c = 0; c < dst.channels.length; c++) {
    const d = dst.channels[c];
    const s = srcN.channels[c];
    for (let i = 0; i < s.length; i++) {
      const j = off + i;
      if (j >= 0) d[j] += s[i] * gain;
    }
  }
  return dst;
}

export function concat(a: Pcm, b: Pcm): Pcm {
  return mixInto(clonePcm(a), b, durationOf(a));
}

export function clampInt(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v | 0));
}

/** Soft-clip to avoid harsh digital overs on export. */
export function softClip(pcm: Pcm): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => c.map((v) => (Math.abs(v) <= 0.9 ? v : Math.sign(v) * (0.9 + 0.1 * Math.tanh((Math.abs(v) - 0.9) / 0.1))))),
  };
}

/** Min/max envelope for waveform drawing. */
export function waveformPeaks(samples: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * per);
    const e = Math.max(a + 1, Math.floor((b + 1) * per));
    let lo = 1;
    let hi = -1;
    for (let i = a; i < e && i < samples.length; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo > hi ? 0 : lo;
    max[b] = lo > hi ? 0 : hi;
  }
  return { min, max };
}

/** Equal-power pan of a stereo buffer. */
export function panPcm(pcm: Pcm, pan: number): Pcm {
  if (!pan || pcm.channels.length < 2) return pcm;
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * Math.SQRT2;
  const gr = Math.sin(a) * Math.SQRT2;
  return { sampleRate: pcm.sampleRate, channels: [pcm.channels[0].map((v) => v * gl), pcm.channels[1].map((v) => v * gr), ...pcm.channels.slice(2)] };
}
