/** Magic-byte sniffing: only genuine audio/video containers are accepted. */
export interface Sniffed {
  kind: 'audio' | 'video' | 'either';
  mime: string;
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function sniffMedia(b: Uint8Array): Sniffed | null {
  if (b.length < 12) return null;
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (/^(M4A |M4B |M4P )/.test(brand)) return { kind: 'audio', mime: 'audio/mp4' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    return { kind: 'either', mime: 'video/mp4' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'either', mime: 'video/webm' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return { kind: 'video', mime: 'video/x-msvideo' };
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'either', mime: 'audio/ogg' };
  if (ascii(b, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac' };
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg' };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync, or ADTS AAC (layer bits 00)
    return (b[1] & 0x06) === 0 ? { kind: 'audio', mime: 'audio/aac' } : { kind: 'audio', mime: 'audio/mpeg' };
  }
  if (ascii(b, 0, 4) === 'FORM' && /AIF[FC]/.test(ascii(b, 8, 4))) return { kind: 'audio', mime: 'audio/aiff' };
  return null;
}
