/**
 * Sound Effector: offline, pure-JS effect chain.
 *
 * Every effect is `(pcm, params) => pcm`. Each one is described in EFFECTS
 * (parameter ranges/defaults) so UIs can be generated automatically.
 */
import { type Pcm, clonePcm, lengthOf, normalize, reverse, resample, applyGain, panPcm } from '../audio/pcm';
import { type Effect, type EffectType, uid } from '../types';

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface EffectSpec {
  type: EffectType;
  label: string;
  params: ParamSpec[];
  process: (pcm: Pcm, p: Record<string, number>) => Pcm;
}

const P = (key: string, label: string, min: number, max: number, def: number, step = 0.01, unit?: string): ParamSpec => ({ key, label, min, max, step, default: def, unit });

// ---------------------------------------------------------------------------
// Biquad (RBJ cookbook)
// ---------------------------------------------------------------------------
type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'lowshelf' | 'highshelf';

export function biquadCoefs(kind: BiquadKind, sr: number, freq: number, q: number, gainDb = 0) {
  const w0 = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(1e-4, q));
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (kind) {
    case 'lowpass':
      [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'highpass':
      [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'bandpass':
      [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'peaking':
      [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s), A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s];
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s), A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s];
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquad(kind: BiquadKind) {
  return (pcm: Pcm, p: Record<string, number>): Pcm => {
    const c = biquadCoefs(kind, pcm.sampleRate, p.freq, p.q, p.gain ?? 0);
    const out = clonePcm(pcm);
    for (const ch of out.channels) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        ch[i] = y;
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Time-domain effects
// ---------------------------------------------------------------------------

function withTail(pcm: Pcm, tailSeconds: number): Pcm {
  const add = Math.round(tailSeconds * pcm.sampleRate);
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => {
      const o = new Float32Array(c.length + add);
      o.set(c);
      return o;
    }),
  };
}

function delay(pcm: Pcm, p: Record<string, number>): Pcm {
  const fb = Math.min(0.95, p.feedback);
  const tail = fb > 0 ? p.time * Math.ceil(Math.log(0.001) / Math.log(Math.max(1e-3, fb))) : p.time;
  const out = withTail(pcm, Math.min(10, tail));
  const d = Math.max(1, Math.round(p.time * pcm.sampleRate));
  out.channels.forEach((ch, ci) => {
    const dry = ch.slice();
    const buf = new Float32Array(d);
    // ping-pong: offset right channel buffer phase for stereo width
    let w = ci === 1 && p.pingpong ? Math.floor(d / 2) : 0;
    for (let i = 0; i < ch.length; i++) {
      const delayed = buf[w];
      buf[w] = dry[i] + delayed * fb;
      w = (w + 1) % d;
      ch[i] = dry[i] * (1 - p.mix) + delayed * p.mix;
    }
  });
  return out;
}

/** Freeverb-style Schroeder/Moorer reverb. */
function reverb(pcm: Pcm, p: Record<string, number>): Pcm {
  const sr = pcm.sampleRate;
  const scale = sr / 44100;
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const room = 0.7 + 0.28 * p.size;
  const damp = p.damp;
  const out = withTail(pcm, 0.5 + 3 * p.size);
  out.channels.forEach((ch, ci) => {
    const spread = ci * 23;
    const combs = combT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * scale)), i: 0, store: 0 }));
    const aps = apT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * scale)), i: 0 }));
    const dry = ch.slice();
    for (let n = 0; n < ch.length; n++) {
      const input = dry[n] * 0.015;
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = input + c.store * room;
        c.i = (c.i + 1) % c.buf.length;
        acc += y;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = acc + b * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        acc = b - acc;
      }
      ch[n] = dry[n] * (1 - p.mix) + acc * p.mix * 3;
    }
  });
  return out;
}

function chorus(pcm: Pcm, p: Record<string, number>): Pcm {
  const sr = pcm.sampleRate;
  const base = 0.015 * sr;
  const depth = (p.depth / 1000) * sr;
  const out = clonePcm(pcm);
  out.channels.forEach((ch, ci) => {
    const dry = ch.slice();
    const phase = ci * Math.PI / 2;
    for (let i = 0; i < ch.length; i++) {
      const d = base + depth * (0.5 + 0.5 * Math.sin((2 * Math.PI * p.rate * i) / sr + phase));
      const pos = i - d;
      const i0 = Math.floor(pos);
      const f = pos - i0;
      const a = i0 >= 0 ? dry[i0] : 0;
      const b = i0 + 1 >= 0 ? dry[i0 + 1] ?? 0 : 0;
      const wet = a + (b - a) * f;
      ch[i] = dry[i] * (1 - p.mix * 0.5) + wet * p.mix * 0.5;
    }
  });
  return out;
}

function compressor(pcm: Pcm, p: Record<string, number>): Pcm {
  const sr = pcm.sampleRate;
  const atk = Math.exp(-1 / (Math.max(1e-4, p.attack) * sr));
  const rel = Math.exp(-1 / (Math.max(1e-4, p.release) * sr));
  const makeup = Math.pow(10, p.makeup / 20);
  const out = clonePcm(pcm);
  const n = lengthOf(out);
  let env = 0;
  for (let i = 0; i < n; i++) {
    let lvl = 0;
    for (const ch of out.channels) lvl = Math.max(lvl, Math.abs(ch[i]));
    env = lvl > env ? atk * env + (1 - atk) * lvl : rel * env + (1 - rel) * lvl;
    const db = 20 * Math.log10(Math.max(1e-9, env));
    const over = db - p.threshold;
    const grDb = over > 0 ? over - over / p.ratio : 0;
    const g = Math.pow(10, -grDb / 20) * makeup;
    for (const ch of out.channels) ch[i] *= g;
  }
  return out;
}

function distortion(pcm: Pcm, p: Record<string, number>): Pcm {
  const k = Math.max(1, p.drive);
  const norm = Math.tanh(k);
  return { sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => c.map((v) => v * (1 - p.mix) + (Math.tanh(v * k) / norm) * p.mix * 0.8)) };
}

function bitcrush(pcm: Pcm, p: Record<string, number>): Pcm {
  const levels = Math.pow(2, Math.max(1, Math.round(p.bits)) - 1);
  const hold = Math.max(1, Math.round(p.downsample));
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => {
      const o = new Float32Array(c.length);
      let held = 0;
      for (let i = 0; i < c.length; i++) {
        if (i % hold === 0) held = Math.round(c[i] * levels) / levels;
        o[i] = held;
      }
      return o;
    }),
  };
}

function tremolo(pcm: Pcm, p: Record<string, number>): Pcm {
  const sr = pcm.sampleRate;
  return {
    sampleRate: sr,
    channels: pcm.channels.map((c) => c.map((v, i) => v * (1 - p.depth * (0.5 + 0.5 * Math.sin((2 * Math.PI * p.rate * i) / sr))))),
  };
}

/** Repeat the first `length` seconds `repeats` times, then continue (classic stutter/roll). */
function stutter(pcm: Pcm, p: Record<string, number>): Pcm {
  const L = Math.max(1, Math.round(p.length * pcm.sampleRate));
  const reps = Math.max(1, Math.round(p.repeats));
  const decay = p.decay ?? 0;
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => {
      const head = c.subarray(0, Math.min(L, c.length));
      const out = new Float32Array(head.length * reps + Math.max(0, c.length - head.length));
      for (let r = 0; r < reps; r++) {
        const g = Math.pow(1 - decay, r);
        for (let i = 0; i < head.length; i++) {
          // tiny crossfade at slice edges to avoid clicks
          const edge = Math.min(1, i / 32, (head.length - i) / 32);
          out[r * head.length + i] = head[i] * g * (r < reps - 1 ? edge : Math.min(1, i / 32));
        }
      }
      out.set(c.subarray(head.length), head.length * reps);
      return out;
    }),
  };
}

function speed(pcm: Pcm, p: Record<string, number>): Pcm {
  const rate = Math.max(0.05, p.rate * Math.pow(2, (p.semitones ?? 0) / 12));
  // play `rate` times faster: resample to sr/rate and reinterpret at sr
  const r = resample(pcm, Math.round(pcm.sampleRate / rate));
  return { sampleRate: pcm.sampleRate, channels: r.channels };
}

export const EFFECTS: Record<EffectType, EffectSpec> = {
  gain: { type: 'gain', label: 'Gain', params: [P('db', 'Gain', -48, 24, 0, 0.5, 'dB')], process: (x, p) => applyGain(x, Math.pow(10, p.db / 20)) },
  pan: { type: 'pan', label: 'Pan', params: [P('pan', 'Pan', -1, 1, 0)], process: (x, p) => panPcm(x, p.pan) },
  lowpass: { type: 'lowpass', label: 'Low-pass', params: [P('freq', 'Cutoff', 20, 20000, 2000, 1, 'Hz'), P('q', 'Q', 0.1, 20, 0.707)], process: biquad('lowpass') },
  highpass: { type: 'highpass', label: 'High-pass', params: [P('freq', 'Cutoff', 20, 20000, 200, 1, 'Hz'), P('q', 'Q', 0.1, 20, 0.707)], process: biquad('highpass') },
  bandpass: { type: 'bandpass', label: 'Band-pass', params: [P('freq', 'Centre', 20, 20000, 1000, 1, 'Hz'), P('q', 'Q', 0.1, 20, 1)], process: biquad('bandpass') },
  peaking: { type: 'peaking', label: 'EQ bell', params: [P('freq', 'Freq', 20, 20000, 1000, 1, 'Hz'), P('q', 'Q', 0.1, 20, 1), P('gain', 'Gain', -24, 24, 0, 0.5, 'dB')], process: biquad('peaking') },
  lowshelf: { type: 'lowshelf', label: 'Low shelf', params: [P('freq', 'Freq', 20, 2000, 200, 1, 'Hz'), P('q', 'Q', 0.1, 4, 0.707), P('gain', 'Gain', -24, 24, 0, 0.5, 'dB')], process: biquad('lowshelf') },
  highshelf: { type: 'highshelf', label: 'High shelf', params: [P('freq', 'Freq', 1000, 20000, 6000, 1, 'Hz'), P('q', 'Q', 0.1, 4, 0.707), P('gain', 'Gain', -24, 24, 0, 0.5, 'dB')], process: biquad('highshelf') },
  distortion: { type: 'distortion', label: 'Distortion', params: [P('drive', 'Drive', 1, 50, 5, 0.1), P('mix', 'Mix', 0, 1, 1)], process: distortion },
  bitcrush: { type: 'bitcrush', label: 'Bitcrusher', params: [P('bits', 'Bits', 1, 16, 8, 1), P('downsample', 'Downsample', 1, 64, 4, 1, 'x')], process: bitcrush },
  delay: { type: 'delay', label: 'Delay', params: [P('time', 'Time', 0.01, 2, 0.25, 0.01, 's'), P('feedback', 'Feedback', 0, 0.95, 0.35), P('mix', 'Mix', 0, 1, 0.35), P('pingpong', 'Ping-pong', 0, 1, 0, 1)], process: delay },
  reverb: { type: 'reverb', label: 'Reverb', params: [P('size', 'Size', 0, 1, 0.6), P('damp', 'Damping', 0, 1, 0.4), P('mix', 'Mix', 0, 1, 0.3)], process: reverb },
  chorus: { type: 'chorus', label: 'Chorus', params: [P('rate', 'Rate', 0.05, 8, 1.2, 0.05, 'Hz'), P('depth', 'Depth', 0, 20, 4, 0.1, 'ms'), P('mix', 'Mix', 0, 1, 0.5)], process: chorus },
  compressor: { type: 'compressor', label: 'Compressor', params: [P('threshold', 'Threshold', -60, 0, -18, 0.5, 'dB'), P('ratio', 'Ratio', 1, 20, 4, 0.1), P('attack', 'Attack', 0.0005, 0.2, 0.005, 0.0005, 's'), P('release', 'Release', 0.01, 1, 0.1, 0.01, 's'), P('makeup', 'Makeup', 0, 24, 0, 0.5, 'dB')], process: compressor },
  tremolo: { type: 'tremolo', label: 'Tremolo', params: [P('rate', 'Rate', 0.1, 30, 6, 0.1, 'Hz'), P('depth', 'Depth', 0, 1, 0.5)], process: tremolo },
  stutter: { type: 'stutter', label: 'Stutter', params: [P('length', 'Slice', 0.01, 1, 0.08, 0.005, 's'), P('repeats', 'Repeats', 1, 32, 4, 1), P('decay', 'Decay', 0, 0.9, 0)], process: stutter },
  reverse: { type: 'reverse', label: 'Reverse', params: [], process: (x) => reverse(x) },
  speed: { type: 'speed', label: 'Speed / pitch', params: [P('rate', 'Rate', 0.25, 4, 1, 0.01, 'x'), P('semitones', 'Semitones', -24, 24, 0, 1, 'st')], process: speed },
  normalize: { type: 'normalize', label: 'Normalize', params: [P('peak', 'Peak', 0.1, 1, 0.98)], process: (x, p) => normalize(x, p.peak) },
};

export function createEffect(type: EffectType, params: Record<string, number> = {}): Effect {
  const spec = EFFECTS[type];
  const defaults = Object.fromEntries(spec.params.map((s) => [s.key, s.default]));
  return { id: uid('fx'), type, enabled: true, params: { ...defaults, ...params } };
}

export function applyEffect(pcm: Pcm, fx: Effect): Pcm {
  if (!fx.enabled) return pcm;
  const spec = EFFECTS[fx.type];
  if (!spec) throw new Error(`Unknown effect ${fx.type}`);
  const defaults = Object.fromEntries(spec.params.map((s) => [s.key, s.default]));
  return spec.process(pcm, { ...defaults, ...fx.params });
}

export function applyEffects(pcm: Pcm, chain: Effect[]): Pcm {
  return chain.reduce((acc, fx) => applyEffect(acc, fx), pcm);
}
