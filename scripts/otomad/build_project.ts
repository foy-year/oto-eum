/**
 * 音MAD recipe: MIDI read from a piano-roll video + samples cut from another video.
 * Uses only the oto-eum core. Writes project.json (for the video render) and mix.wav.
 *
 *   npx vite-node scripts/otomad/build_project.ts <workdir>
 *   (expects <workdir>/roll.json from read_roll.ts and <workdir>/a48.wav = audio of the sample video)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeWav, encodeWav } from '../../src/core/audio/wav';
import { type Pcm, slice, rms, durationOf, toMono, lengthOf } from '../../src/core/audio/pcm';
import { detectRootPitch, midiToName } from '../../src/core/analysis/pitch';
import { detectOnsets } from '../../src/core/analysis/onset';
import { stft } from '../../src/core/analysis/fft';
import { createProject, createSample, createTrack } from '../../src/core/project';
import { createEffect } from '../../src/core/render/effects';
import { autoLevel, mixProject } from '../../src/core/render/mix';
import { quantize, gridSeconds, shiftTime, endTime } from '../../src/core/midi/midi';
import type { Note, NoteTrack, Sample, VideoClip, VideoFx } from '../../src/core/types';

const W = process.argv[2];
const src = decodeWav(readFileSync(`${W}/a48.wav`));
// optional: voices from a separated vocals stem (e.g. Demucs), picture still from the video
const USE_VOCALS = process.argv.includes('--vocals');
const vocals = USE_VOCALS ? decodeWav(readFileSync(`${W}/a_vocals48.wav`)) : null;
const load = async (id: string) => (id === 'ad-vocals' && vocals ? vocals : src);
const roll: NoteTrack[] = JSON.parse(readFileSync(`${W}/roll.json`, 'utf8'));
const byName = (k: string) => roll.find((t) => t.name.includes(k))!;

// ---------------------------------------------------------------------------
// 1. Tempo + grid from the note starts, then quantize
// ---------------------------------------------------------------------------
const starts = roll.flatMap((t) => t.notes.map((n) => n.start));
let best = { bpm: 0, off: 0, err: Infinity };
for (let bpm = 160; bpm <= 170; bpm += 0.01) {
  const g = gridSeconds(bpm, 16);
  for (let off = 1.5; off < 1.5 + g; off += 0.002) {
    let e = 0;
    for (const s of starts) {
      const d = (s - off) / g;
      e += (d - Math.round(d)) ** 2;
    }
    if (e < best.err) best = { bpm, off, err: e };
  }
}
const BPM = Math.round(best.bpm * 10) / 10;
const beat = 60 / BPM;
console.log(`tempo ≈ ${best.bpm.toFixed(2)} → ${BPM} BPM, grid offset ${best.off.toFixed(3)} s, rms grid error ${Math.sqrt(best.err / starts.length).toFixed(3)} steps`);
// genre template: ~3 bars of the subject's own footage + sound before the song (like the references)
const LEAD = 3 * (240 / BPM);
const songStart = best.off; // first downbeat in the MIDI video's timeline
const tidy = (notes: Note[]) =>
  shiftTime(quantize(notes, BPM, 16, { offset: songStart }), LEAD - songStart).filter((n) => n.duration > 0.02);

// ---------------------------------------------------------------------------
// 2. Samples (regions of the ad: sound AND picture)
// ---------------------------------------------------------------------------
function rootOf(a: number, b: number, fallback: number, from: Pcm = src) {
  const r = detectRootPitch(slice(from, a, b), { minHz: 60, maxHz: 1000, threshold: 0.25 });
  return r && r.confidence > 0.5 ? r.midi : fallback;
}
function sampleAt(name: string, a: number, b: number, fallbackRoot: number, extra: Partial<Sample> = {}): Sample {
  const m = rootOf(a, b, fallbackRoot, extra.audioId === 'ad-vocals' && vocals ? vocals : src);
  const s = createSample('ad', a, b, { name, rootPitch: Math.round(m), rootCents: Math.round((m - Math.round(m)) * 100), effects: [createEffect('normalize', { peak: 0.9 })], ...extra });
  console.log(`sample ${name.padEnd(10)} ${a.toFixed(2)}–${b.toFixed(2)}  root ${midiToName(m)} (${m.toFixed(2)})`);
  return s;
}

const S = {
  // family video-call shot: stable vowel → looped so held notes sing
  main: sampleAt('family', 11.35, 11.445, 55, { sustain: 'loop', release: 0.05, fadeIn: 0.004, fadeOut: 0.004 , ...(vocals ? { audioId: 'ad-vocals' } : {}) }),
  // girl-in-bed scene, voice-over syllable
  harmony: sampleAt('bedroom', 4.35, 4.5, 52, { sustain: 'cut', release: 0.04 , ...(vocals ? { audioId: 'ad-vocals' } : {}) }),
  // "life — так легко" logo card voice-over vowel, looped for the sustained chords
  chorus: sampleAt('logo-card', 10.42, 10.555, 44, { sustain: 'loop', release: 0.08, fadeIn: 0.006, fadeOut: 0.006 , ...(vocals ? { audioId: 'ad-vocals' } : {}) }),
  // the ad's intro music: a clean low D
  bass: sampleAt('intro', 0.45, 0.64, 38, { sustain: 'cut', release: 0.03 }),
  // the sung/synth "life:)" jingle tone on the end card
  arp: sampleAt('jingle', 22.75, 22.98, 78, { sustain: 'cut', release: 0.03 }),
  // sofa scene voice-over, pitched way up for the crazy-pitch track
  wild: sampleAt('sofa', 20.0, 20.095, 45, { sustain: 'loop', release: 0.03 , ...(vocals ? { audioId: 'ad-vocals' } : {}) }),
};
// the intro region also contains the ad's pad chords: keep only the bass partials before pitching
S.bass.effects = [createEffect('lowpass', { freq: 280, q: 0.7 }), createEffect('lowpass', { freq: 280, q: 0.7 }), createEffect('normalize', { peak: 0.9 })];

// ---------------------------------------------------------------------------
// 3. Drums from the ad's own transients (the MIDI has no drum track)
// ---------------------------------------------------------------------------
function bandFeatures(t: number) {
  const seg = slice(src, t, t + 0.12);
  const x = toMono(seg);
  const spec = stft(x, 1024, 256);
  const binHz = src.sampleRate / 1024;
  let low = 0, mid = 0, high = 0;
  for (const fr of spec.slice(0, 3))
    fr.forEach((v, k) => {
      const f = k * binHz;
      if (f < 150) low += v * v;
      else if (f < 2500) mid += v * v;
      else if (f > 5000) high += v * v;
    });
  const tot = low + mid + high + 1e-12;
  const early = rms(x, 0, Math.round(0.03 * src.sampleRate));
  const late = rms(x, Math.round(0.08 * src.sampleRate), x.length);
  return { t, low: low / tot, high: high / tot, punch: early, decay: late / (early + 1e-9) };
}
const { onsets } = detectOnsets(src, { sensitivity: 1.0, minInterval: 0.05 });
const feats = onsets.filter((t) => t > 0.05 && t < 22.5).map(bandFeatures).filter((f) => f.punch > 0.05);
const kickF = feats.slice().sort((a, b) => b.low * (1 - b.decay) - a.low * (1 - a.decay))[0];
const snareF = feats.filter((f) => Math.abs(f.t - kickF.t) > 0.2).sort((a, b) => b.high * b.punch - a.high * a.punch)[0];
const hatF = feats.filter((f) => ![kickF.t, snareF.t].includes(f.t)).sort((a, b) => b.high - a.high)[0];
console.log('drums: kick', kickF, '\n       snare', snareF, '\n       hat', hatF);
const pre = 0.008; // keep the attack
const D = {
  kick: createSample('ad', kickF.t - pre, kickF.t + 0.16, { name: 'kick', effects: [createEffect('normalize', { peak: 0.9 })], pitchMode: 'fixed', sustain: 'full', fadeOut: 0.05 }),
  snare: createSample('ad', snareF.t - pre, snareF.t + 0.14, { name: 'snare', effects: [createEffect('normalize', { peak: 0.9 })], pitchMode: 'fixed', sustain: 'full', fadeOut: 0.05 }),
  hat: createSample('ad', hatF.t - pre, hatF.t + 0.05, { name: 'hat', effects: [createEffect('normalize', { peak: 0.9 })], pitchMode: 'fixed', sustain: 'full', fadeOut: 0.02 }),
};

// ---------------------------------------------------------------------------
// 4. Arrangement
// ---------------------------------------------------------------------------
const tracks = {
  main: createTrack('Main (family)', { notes: tidy(byName('メイン').notes), sampleId: S.main.id, gain: 1.0, effects: [createEffect('highpass', { freq: 140 }), createEffect('compressor', { threshold: -20, ratio: 3, makeup: 4 }), createEffect('reverb', { size: 0.45, mix: 0.18 })] }),
  harmony: createTrack('Harmony (bedroom)', { notes: tidy(byName('ハモリ').notes), sampleId: S.harmony.id, gain: 0.55, pan: -0.35, effects: [createEffect('highpass', { freq: 160 }), createEffect('reverb', { size: 0.5, mix: 0.2 })] }),
  chorus: createTrack('Chorus (logo card)', { notes: tidy(byName('コーラス').notes), sampleId: S.chorus.id, gain: 0.32, pan: 0.3, effects: [createEffect('highpass', { freq: 180 }), createEffect('lowpass', { freq: 4500 }), createEffect('chorus', { rate: 0.8, depth: 5, mix: 0.5 }), createEffect('reverb', { size: 0.7, mix: 0.3 })] }),
  bass: createTrack('Bass (intro)', { notes: tidy(byName('ベース').notes), sampleId: S.bass.id, gain: 0.9, effects: [createEffect('lowpass', { freq: 2200 }), createEffect('compressor', { threshold: -18, ratio: 4, makeup: 3 })] }),
  arp: createTrack('Arpeggio (jingle)', { notes: tidy(byName('アルペジオ').notes), sampleId: S.arp.id, gain: 0.4, pan: 0.15, effects: [createEffect('delay', { time: (beat * 3) / 4, feedback: 0.25, mix: 0.18, pingpong: 1 })] }),
  wild: createTrack('Wild (sofa)', { notes: tidy(byName('音程').notes), sampleId: S.wild.id, gain: 0.45, pan: -0.15, effects: [createEffect('highpass', { freq: 200 }), createEffect('reverb', { size: 0.4, mix: 0.15 })] }),
};
const songEnd = endTime(Object.values(tracks));
// drums enter with the full band (first harmony/chorus note), quarter-note grid
const fullIn = Math.min(...[tracks.harmony, tracks.chorus, tracks.arp].map((t) => t.notes[0].start));
const bar = beat * 4;
const firstBar = LEAD + Math.round((fullIn - LEAD) / bar) * bar;
const kick: Note[] = [], snare: Note[] = [], hat: Note[] = [];
let k = 0;
for (let t = firstBar; t < songEnd - 0.01; t += beat / 2, k++) {
  const n = (dur: number, v: number): Note => ({ id: `d${k}-${v}`, pitch: 60, start: t, duration: dur, velocity: v });
  if (k % 4 === 0 || k % 8 === 7) kick.push(n(0.15, 1));
  if (k % 4 === 2) snare.push(n(0.13, 0.9));
  hat.push(n(0.05, k % 2 ? 0.5 : 0.8));
}
const drumTracks = [
  createTrack('Kick', { notes: kick, sampleId: D.kick.id, gain: 1.1, effects: [createEffect('lowpass', { freq: 1800 }), createEffect('compressor', { threshold: -16, ratio: 4, makeup: 6 })] }),
  createTrack('Snare', { notes: snare, sampleId: D.snare.id, gain: 0.7, effects: [createEffect('highpass', { freq: 250 }), createEffect('reverb', { size: 0.3, mix: 0.15 })] }),
  createTrack('Hat', { notes: hat, sampleId: D.hat.id, gain: 0.35, effects: [createEffect('highpass', { freq: 6000 })] }),
];

// Outro: the ad's own end card ("life:) так легко") played as-is after the song
const outroStart = LEAD + Math.ceil((songEnd - LEAD) / bar - 0.1) * bar;
const OUTRO = { a: 21.0, b: 23.0 };
const outroSample = createSample('ad', OUTRO.a, OUTRO.b, { name: 'end card', pitchMode: 'fixed', sustain: 'full', fadeIn: 0.01, fadeOut: 0.3 });
const outroTrack = createTrack('Outro (end card)', { notes: [{ id: 'outro', pitch: 60, start: outroStart, duration: OUTRO.b - OUTRO.a, velocity: 1 }], sampleId: outroSample.id, gain: 0.9 });

// Intro: the ad's opening (man, room, life:) logo, its music) as-is
const introSample = createSample('ad', 0, LEAD, { name: 'ad opening', pitchMode: 'fixed', sustain: 'full', fadeIn: 0.005, fadeOut: 0.25 });
const introTrack = createTrack('Intro (ad opening)', { notes: [{ id: 'intro', pitch: 60, start: 0, duration: LEAD, velocity: 1 }], sampleId: introSample.id, gain: 0.9 });

const project = createProject('life:) × YOUKAI ZONE 音MAD');
project.bpm = BPM;
project.sampleRate = 48000;
project.samples = [...Object.values(S), ...Object.values(D), outroSample, introSample];
const melodic = [tracks.main, tracks.harmony, tracks.wild, tracks.bass, tracks.chorus, tracks.arp];
project.tracks = [...melodic, ...drumTracks, outroTrack, introTrack];
project.videoTrackIds = melodic.map((t) => t.id);
// ---------------------------------------------------------------------------
// v4: YOUKAI ZONE template (from 20 reference 音MADs, song-aligned)
// ---------------------------------------------------------------------------
const wildStart = Math.min(...tracks.wild.notes.map((n) => n.start));
const B = (n: number) => LEAD + (n - 1) * bar; // start of song bar n
const T = tracks;
const five = [T.main.id, T.harmony.id, T.chorus.id, T.bass.id, T.arp.id];
project.videoScenes = [
  { id: 'b1', from: 0, layout: 'single', order: [T.main.id] }, // + mirror FX
  { id: 'b3', from: B(3), layout: 'columns', order: [T.main.id, T.bass.id] },
  { id: 'b5', from: B(5), layout: 'focus', order: five },
  { id: 'b9', from: B(9), layout: 'single', order: [T.main.id] }, // title over the subject
  // 3 on top + 2 wide below: a 5-cell grid would leave a black gap
  { id: 'b11', from: B(11), layout: 'custom', order: five, rects: {
    [T.main.id]: { x: 0, y: 0, w: 1 / 3, h: 0.5 }, [T.harmony.id]: { x: 1 / 3, y: 0, w: 1 / 3, h: 0.5 }, [T.chorus.id]: { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
    [T.bass.id]: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, [T.arp.id]: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } } },
  { id: 'b13', from: Math.min(B(13), wildStart), layout: 'grid', order: [T.main.id, T.harmony.id, T.wild.id, T.bass.id, T.chorus.id, T.arp.id] },
];
project.videoSync = { ...project.videoSync, width: 1280, height: 720, fps: 30, layout: 'grid', alternateFlip: true, hueByPitch: false, punch: 1.1, flash: 0.3, holdLastFrame: true, background: '#0b0d14' };
project.videoSync = { ...project.videoSync, rotate: 4, shake: 0.02, zoomDrift: 0.06, greyHeld: false, pulseTrackIds: [drumTracks[0].id], pulseFlash: 0.14, pulseZoom: 0.03 };
const fx = (kind: VideoFx['kind'], start: number, end: number, params: Record<string, number> = {}, color?: string, fade?: number): VideoFx => ({ id: `${kind}${start.toFixed(2)}`, kind, start, end, params, color, fade });
const songOut = Math.ceil((songEnd - LEAD) / bar - 0.1);
project.videoFx = [
  // sections
  fx('mirror', B(1), B(3), { mode: 0 }),
  fx('tile', B(13), B(15), { n: 2, spin: 0, zoom: 1 }),
  fx('kaleido', B(15), B(1 + songOut), { segments: 8, spin: 40, zoom: 1.25 }),
  // colour: vivid overall, warm montage, cool title/grid section
  fx('grade', 0, B(1 + songOut) + 2.5, { saturate: 1.45, contrast: 1.12, brightness: 1.06 }, undefined, 0),
  fx('grade', B(5), B(9), { saturate: 1.2, tint: 0.35 }, '#ff8a3d'),
  fx('grade', B(9), B(13), { saturate: 1.1, tint: 0.4, hue: -10 }, '#28d7ff'),
  // title burst at bar 9
  fx('burst', B(9), B(11), { count: 56, inner: 0.34, alpha: 0.75 }, '#ffffff'),
  fx('glass', B(9), B(11), { count: 9, alpha: 0.85 }),
  // white flashes on every section change
  ...[1, 3, 5, 9, 11, 13, 15].map((n) => fx('flash', B(n), B(n) + 0.45, { decay: n === 9 || n === 1 ? 0.22 : 0.12, alpha: n === 9 ? 1 : 0.7 }, '#ffffff')),
  fx('flash', B(1 + songOut), B(1 + songOut) + 0.5, { decay: 0.2, alpha: 0.9 }, '#ffffff'),
];
project.texts = [
  { id: 'yz', text: 'YOUKAI\nZONE »', start: B(9), end: B(11), x: 0.4, y: 0.5, size: 0.085, color: '#ffffff', stroke: '#101522', align: 'right', anim: 'slide', font: 'sans' },
  { id: 'word', text: 'ライフ', start: B(9) + 0.1, end: B(11), x: 0.43, y: 0.5, size: 0.21, color: '#e8252e', stroke: '#ffffff', align: 'left', anim: 'pop', font: 'serif' },
  { id: 'credit', text: 'MIDI: YOUKAIZONE厳禁リスペクト専用midi · sounds & video: life:) ad · made with oto-eum', start: 0, end: 0, x: 0.5, y: 0.93, size: 0.032, color: '#2b3a5a', anim: 'fade', bold: false },
];
const clip: VideoClip = { id: 'outro', sourceId: 'ad', start: outroStart, sourceIn: OUTRO.a, sourceOut: OUTRO.b, rate: 1, layer: 0, rect: { x: 0, y: 0, w: 1, h: 1 } };
const introClip: VideoClip = { id: 'intro', sourceId: 'ad', start: 0, sourceIn: 0, sourceOut: LEAD, rate: 1, layer: 0, rect: { x: 0, y: 0, w: 1, h: 1 } };
project.videoClips = [introClip, clip];
project.texts[2].start = outroStart + 0.2;
project.texts[2].end = outroStart + (OUTRO.b - OUTRO.a) + 0.3;
void wildStart;

// ---------------------------------------------------------------------------
// 5. Mix
// ---------------------------------------------------------------------------
// auto-level (core): every track to −20 LUFS + its offset; master normalised to −14 LUFS
const OFFSET: Record<string, number> = { 'Intro (ad opening)': 2, 'Main (family)': 3, 'Harmony (bedroom)': -3, 'Wild (sofa)': 0, 'Bass (intro)': 0, 'Chorus (logo card)': -5, 'Arpeggio (jingle)': -3, Kick: 1, Snare: -2, Hat: -8, 'Outro (end card)': 2 };
for (const t of project.tracks) t.levelOffset = OFFSET[t.name] ?? 0;
const lv = await autoLevel(project, load);
for (const t of project.tracks) if (lv[t.id]) t.gain = lv[t.id].gain;
// the references master loud (median ≈ −9 LUFS); limiter keeps peaks at −1 dBTP instead of clipping
project.masterEffects = [createEffect('compressor', { threshold: -18, ratio: 4, attack: 0.003, release: 0.1, makeup: 3 })];
project.masterLoudness = -9;
project.masterCeiling = -1.5; // sample-peak ceiling; leaves room for inter-sample peaks
const activeRms = (p: Pcm) => {
  const x = toMono(p);
  const win = 2400;
  const vals: number[] = [];
  for (let i = 0; i + win < x.length; i += win) vals.push(rms(x, i, i + win));
  const on = vals.filter((v) => v > 0.005);
  return on.length ? Math.sqrt(on.reduce((s, v) => s + v * v, 0) / on.length) : 0;
};
const { master, stems, loudness } = await mixProject(project, load);
{
  const { checkProject } = await import('../../src/core/render/check');
  const rep = await checkProject(project, load);
  for (const t of rep.tracks)
    if (t.pitch) console.log(`self-check ${t.name.padEnd(20)} MIDI match ${Math.round((t.midiMatch ?? 0) * 100)}%  tuning ${t.pitch.checked ? Math.round(t.pitch.medianError * 100) + '¢' : '—'} ${t.issues.join('; ')}`);
}
console.log(`master ${loudness.integrated.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP`);
for (const t of project.tracks) {
  const st = stems[t.id];
  if (st) console.log(`stem ${t.name.padEnd(20)} notes=${String(t.notes.length).padStart(3)} gain=${(t.gain ?? 1).toFixed(2)} active rms=${activeRms(st).toFixed(3)}`);
}
const total = outroStart + (OUTRO.b - OUTRO.a) + 0.3;
const out: Pcm = slice(master, 0, Math.min(durationOf(master), total));
console.log(`mix ${durationOf(out).toFixed(2)} s, ${lengthOf(out)} samples; song ${LEAD.toFixed(2)}–${songEnd.toFixed(2)} s, full band from ${firstBar.toFixed(2)} s, outro at ${outroStart.toFixed(2)} s`);
writeFileSync(`${W}/mix.wav`, encodeWav(out));
writeFileSync(`${W}/project.json`, JSON.stringify({ project, meta: { BPM, LEAD, firstBar, songEnd, outroStart, total: durationOf(out) } }, null, 1));

// ---------------------------------------------------------------------------
// 6. Self-checks: is every sampled note at the right pitch?
// ---------------------------------------------------------------------------
for (const t of melodic) {
  const st = stems[t.id];
  const errs: number[] = [];
  for (const n of t.notes) {
    if (n.duration < 0.12) continue;
    const solo = n.start + 0.02;
    // skip notes overlapped by another note of the same track (chords)
    if (t.notes.some((m) => m !== n && m.start < n.start + n.duration && m.start + m.duration > n.start)) continue;
    const r = detectRootPitch(slice(st, solo, solo + Math.min(0.2, n.duration - 0.04)), { minHz: 50, maxHz: 2000, threshold: 0.2 });
    if (r) errs.push(Math.abs(((r.midi - n.pitch + 6 + 120) % 12) - 6));
  }
  errs.sort((a, b) => a - b);
  console.log(`pitch check ${t.name.padEnd(20)} ${errs.length} solo notes, median error ${(errs[errs.length >> 1] ?? NaN).toFixed(2)} st, within ±0.5 st: ${errs.length ? Math.round((100 * errs.filter((e) => e < 0.5).length) / errs.length) : 0}%`);
}

// chroma agreement between each rendered stem and its own MIDI (works for chords / short notes)
function chromaCorr(st: Pcm, notes: Note[]) {
  const x = toMono(st);
  const N = 4096, H = 1024;
  const spec = stft(x, N, H);
  const binHz = st.sampleRate / N;
  const cs: number[] = [];
  spec.forEach((fr, i) => {
    const t = (i * H + N / 2) / st.sampleRate;
    const want = new Array(12).fill(0);
    for (const n of notes) if (n.start <= t && n.start + n.duration > t) want[((Math.round(n.pitch) % 12) + 12) % 12] += 1;
    if (!want.some((v) => v)) return;
    const got = new Array(12).fill(0);
    fr.forEach((v, k) => {
      const f = k * binHz;
      if (f > 80 && f < 2500) got[(((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12] += v * v;
    });
    const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / 12;
    const ma = m(want), mb = m(got);
    let num = 0, da = 0, db = 0;
    for (let k = 0; k < 12; k++) {
      num += (want[k] - ma) * (got[k] - mb);
      da += (want[k] - ma) ** 2;
      db += (got[k] - mb) ** 2;
    }
    if (da > 0 && db > 0) cs.push(num / Math.sqrt(da * db));
  });
  return cs.reduce((s, v) => s + v, 0) / Math.max(1, cs.length);
}
for (const t of melodic) console.log(`chroma check ${t.name.padEnd(20)} stem vs own MIDI: ${chromaCorr(stems[t.id], t.notes).toFixed(2)}`);
