import type { Pcm } from './pcm';

/** Encode PCM as a RIFF/WAVE file (16-bit integer or 32-bit float). */
export function encodeWav(pcm: Pcm, opts: { float?: boolean } = {}): Uint8Array {
  const float = !!opts.float;
  const numCh = pcm.channels.length;
  const len = pcm.channels[0]?.length ?? 0;
  const bytesPerSample = float ? 4 : 2;
  const dataSize = len * numCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * numCh * bytesPerSample, true);
  v.setUint16(32, numCh * bytesPerSample, true);
  v.setUint16(34, bytesPerSample * 8, true);
  w(36, 'data');
  v.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = pcm.channels[c][i];
      if (float) {
        v.setFloat32(o, s, true);
        o += 4;
      } else {
        const x = Math.max(-1, Math.min(1, s));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
    }
  }
  return new Uint8Array(buf);
}

/** Decode a PCM/float WAV file without Web Audio (used in tests & workers). */
export function decodeWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt = 1;
  let numCh = 1;
  let rate = 44100;
  let bits = 16;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = v.getUint16(body, true);
      numCh = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      const bps = bits / 8;
      const frames = Math.floor(size / (bps * numCh));
      const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
          let s: number;
          if (fmt === 3 && bits === 32) s = v.getFloat32(p, true);
          else if (bits === 16) s = v.getInt16(p, true) / 0x8000;
          else if (bits === 24) {
            const x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16);
            s = x / 0x800000;
          } else if (bits === 32) s = v.getInt32(p, true) / 0x80000000;
          else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
          else throw new Error(`Unsupported WAV bit depth ${bits}`);
          channels[c][i] = s;
          p += bps;
        }
      }
      return { sampleRate: rate, channels };
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
