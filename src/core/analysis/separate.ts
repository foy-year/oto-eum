/**
 * Built-in voice separation (no model download): soft time-frequency masks.
 *
 *   vocal mask = centre (stereo) × harmonic (HPSS) × f0 comb × vocal band
 *
 * - centre: vocals are usually mixed in the middle and in phase in L/R
 * - harmonic vs percussive: median filtering along time vs frequency
 * - f0 comb: follow the predominant pitch and keep its harmonics
 * Accompaniment = input − vocals, so the two always add back to the input.
 * Quality is below neural models (Demucs), but it is instant-ish, tiny, and
 * licence-free. For 音MAD samples it removes a lot of background music.
 */
import { type Pcm, lengthOf, toMono, createPcm } from '../audio/pcm';
import { fft, hann } from './fft';
import { trackPitch } from './pitch';

const N = 2048;
const HOP = 512;

interface Spec {
  re: Float32Array[];
  im: Float32Array[];
}

function stftC(x: Float32Array, win: Float32Array): Spec {
  const frames = Math.ceil((x.length + N) / HOP);
  const re: Float32Array[] = [];
  const im: Float32Array[] = [];
  const br = new Float32Array(N);
  const bi = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    const s = f * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      br[i] = (x[s + i] ?? 0) * win[i];
      bi[i] = 0;
    }
    fft(br, bi);
    re.push(br.slice(0, N / 2 + 1));
    im.push(bi.slice(0, N / 2 + 1));
  }
  return { re, im };
}

function istftC(sp: Spec, win: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  const norm = new Float32Array(length);
  const br = new Float32Array(N);
  const bi = new Float32Array(N);
  for (let f = 0; f < sp.re.length; f++) {
    // rebuild the full conjugate-symmetric spectrum, inverse via conj-FFT-conj
    for (let k = 0; k <= N / 2; k++) {
      br[k] = sp.re[f][k];
      bi[k] = -sp.im[f][k];
    }
    for (let k = 1; k < N / 2; k++) {
      br[N - k] = sp.re[f][k];
      bi[N - k] = sp.im[f][k];
    }
    fft(br, bi);
    const s = f * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      const j = s + i;
      if (j < 0 || j >= length) continue;
      out[j] += (br[i] / N) * win[i];
      norm[j] += win[i] * win[i];
    }
  }
  for (let i = 0; i < length; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

export interface SeparateOptions {
  /** 0..1: how hard to cut what is not the voice (mask exponent). */
  strength?: number;
  /** Use the pitch-following comb (best for a single singer/speaker). */
  followPitch?: boolean;
  onProgress?: (f: number) => void;
}

export function separateVoice(pcm: Pcm, opts: SeparateOptions = {}): { vocals: Pcm; accompaniment: Pcm } {
  const sr = pcm.sampleRate;
  const n = lengthOf(pcm);
  const win = hann(N);
  const chans = pcm.channels.length >= 2 ? [pcm.channels[0], pcm.channels[1]] : [pcm.channels[0]];
  const specs = chans.map((c) => stftC(c, win));
  opts.onProgress?.(0.25);
  const F = specs[0].re.length;
  const K = N / 2 + 1;
  const binHz = sr / N;
  // magnitude of the (mid) signal
  const mag: Float32Array[] = [];
  for (let f = 0; f < F; f++) {
    const m = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      let re = 0;
      let im = 0;
      for (const s of specs) {
        re += s.re[f][k];
        im += s.im[f][k];
      }
      m[k] = Math.hypot(re, im) / specs.length;
    }
    mag.push(m);
  }
  // HPSS: harmonic = median over time, percussive = median over frequency
  const L = 8;
  const harm: Float32Array[] = [];
  for (let f = 0; f < F; f++) {
    const h = new Float32Array(K);
    const p = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const tw: number[] = [];
      for (let d = -L; d <= L; d++) tw.push(mag[Math.min(F - 1, Math.max(0, f + d))][k]);
      const fw: number[] = [];
      for (let d = -L; d <= L; d++) fw.push(mag[f][Math.min(K - 1, Math.max(0, k + d))]);
      h[k] = median(tw);
      p[k] = median(fw);
    }
    const m = new Float32Array(K);
    for (let k = 0; k < K; k++) m[k] = (h[k] * h[k]) / (h[k] * h[k] + p[k] * p[k] + 1e-12);
    harm.push(m);
  }
  opts.onProgress?.(0.55);
  // predominant pitch per STFT frame
  const f0 = new Float32Array(F);
  if (opts.followPitch !== false) {
    const frames = trackPitch({ sampleRate: sr, channels: [toMono(pcm)] }, { minHz: 70, maxHz: 1000, threshold: 0.25, hop: Math.round((HOP / sr) * 16000) });
    for (let f = 0; f < F; f++) {
      const t = (f * HOP) / sr;
      const i = frames.findIndex((fr) => fr.time >= t);
      const fr = frames[Math.max(0, i)];
      f0[f] = fr && fr.confidence > 0.6 ? fr.f0 : 0;
    }
  }
  opts.onProgress?.(0.7);
  const power = 1 + 2 * (opts.strength ?? 0.6);
  const masks: Float32Array[] = [];
  for (let f = 0; f < F; f++) {
    const m = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const fHz = k * binHz;
      // vocal band: roll off below 90 Hz and above 10 kHz
      const band = fHz < 90 ? Math.pow(fHz / 90, 2) : fHz > 10000 ? Math.max(0, 1 - (fHz - 10000) / 6000) : 1;
      let centre = 1;
      if (specs.length === 2) {
        const lr = specs[0].re[f][k], li = specs[0].im[f][k];
        const rr = specs[1].re[f][k], ri = specs[1].im[f][k];
        const pl = lr * lr + li * li;
        const pr = rr * rr + ri * ri;
        const cross = lr * rr + li * ri; // Re(L·R*)
        centre = Math.max(0, (2 * cross) / (pl + pr + 1e-12)); // 1 = identical L/R
      }
      let comb = 1;
      if (f0[f] > 0) {
        const h = fHz / f0[f];
        const d = Math.abs(h - Math.round(h)) * f0[f]; // Hz from nearest harmonic
        comb = Math.round(h) >= 1 && Math.round(h) <= 40 ? Math.exp(-((d / Math.max(15, f0[f] * 0.08)) ** 2)) : 0.15;
        comb = 0.15 + 0.85 * comb;
      } else comb = fHz > 2500 ? 0.5 : 0.2; // unvoiced: keep some consonant energy up high
      m[k] = Math.pow(Math.min(1, centre * harm[f][k] * comb * band), power / 2);
    }
    masks.push(m);
  }
  opts.onProgress?.(0.85);
  const vocals = createPcm(sr, pcm.channels.length, n);
  const accompaniment = createPcm(sr, pcm.channels.length, n);
  pcm.channels.forEach((ch, c) => {
    const sp = c < specs.length ? specs[c] : stftC(ch, win);
    const masked: Spec = { re: sp.re.map((r, f) => r.map((v, k) => v * masks[f][k])), im: sp.im.map((r, f) => r.map((v, k) => v * masks[f][k])) };
    const v = istftC(masked, win, n);
    vocals.channels[c].set(v);
    for (let i = 0; i < n; i++) accompaniment.channels[c][i] = ch[i] - v[i];
  });
  opts.onProgress?.(1);
  return { vocals, accompaniment };
}
