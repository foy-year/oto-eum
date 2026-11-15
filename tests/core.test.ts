import { describe, expect, it } from 'vitest';
import {
  type Pcm,
  type Note,
  createPcm,
  lengthOf,
  durationOf,
  encodeWav,
  decodeWav,
  resample,
  hzToMidi,
  midiToHz,
  midiToName,
  nameToMidi,
  detectRootPitch,
  trackPitch,
  framesToNotes,
  detectOnsets,
  estimateTempo,
  exportMidi,
  importMidi,
  quantize,
  splitVoices,
  monophonize,
  legato,
  mergeRepeats,
  noteRate,
  renderTrack,
  createSample,
  createEffect,
  applyEffects,
  EFFECTS,
  biquadCoefs,
  buildSyncEvents,
  sourceTimeAt,
  activeAt,
  layoutRects,
  framesNeeded,
  DEFAULT_SYNC,
  createProject,
  createTrack,
  mixProject,
  rms,
  peak,
} from '../src/core';

const SR = 44100;
const sine = (hz: number, seconds: number, sr = SR, amp = 0.5): Pcm => {
  const p = createPcm(sr, 1, seconds * sr);
  const c = p.channels[0];
  for (let i = 0; i < c.length; i++) c[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return p;
};
const note = (pitch: number, start: number, duration: number, velocity = 1): Note => ({ id: `${pitch}-${start}`, pitch, start, duration, velocity });

describe('pcm + wav', () => {
  it('round-trips 16-bit and float WAV', () => {
    const s = sine(440, 0.1);
    for (const float of [false, true]) {
      const back = decodeWav(encodeWav(s, { float }));
      expect(back.sampleRate).toBe(SR);
      expect(lengthOf(back)).toBe(lengthOf(s));
      let err = 0;
      for (let i = 0; i < lengthOf(s); i++) err = Math.max(err, Math.abs(back.channels[0][i] - s.channels[0][i]));
      expect(err).toBeLessThan(float ? 1e-7 : 1e-4);
    }
  });

  it('resamples while preserving duration and pitch', () => {
    const r = resample(sine(440, 1), 16000);
    expect(r.sampleRate).toBe(16000);
    expect(durationOf(r)).toBeCloseTo(1, 2);
    expect(detectRootPitch(r)!.midi).toBeCloseTo(69, 0);
  });
});

describe('pitch', () => {
  it('converts between Hz, MIDI and names', () => {
    expect(hzToMidi(440)).toBeCloseTo(69);
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
    expect(midiToName(61)).toBe('C#4');
    expect(nameToMidi('A4')).toBe(69);
    expect(nameToMidi('Bb3')).toBe(58);
  });

  it.each([110, 220, 330, 440, 880])('detects root pitch of a %d Hz tone', (hz) => {
    const r = detectRootPitch(sine(hz, 0.5))!;
    expect(Math.abs(r.midi - hzToMidi(hz))).toBeLessThan(0.1);
  });

  it('transcribes a monophonic melody into notes', () => {
    const melody = [60, 64, 67, 72];
    const parts = melody.map((m) => sine(midiToHz(m), 0.25));
    const all = createPcm(SR, 1, SR * 1.2);
    parts.forEach((p, i) => all.channels[0].set(p.channels[0], Math.round(i * 0.3 * SR)));
    const notes = framesToNotes(trackPitch(all));
    expect(notes.map((n) => n.pitch)).toEqual(melody);
    notes.forEach((n, i) => {
      expect(n.start).toBeCloseTo(i * 0.3, 1);
      expect(n.duration).toBeGreaterThan(0.15);
    });
  });
});

describe('onsets + tempo', () => {
  it('finds clicks and their tempo', () => {
    const bpm = 120;
    const p = createPcm(SR, 1, SR * 8);
    const beats: number[] = [];
    for (let t = 0.25; t < 7.8; t += 60 / bpm) {
      beats.push(t);
      const i0 = Math.round(t * SR);
      for (let i = 0; i < 2000; i++) p.channels[0][i0 + i] = Math.exp(-i / 300) * Math.sin(i * 0.3);
    }
    const res = detectOnsets(p);
    expect(res.onsets.length).toBe(beats.length);
    res.onsets.forEach((t, i) => expect(Math.abs(t - beats[i])).toBeLessThan(0.03));
    expect(estimateTempo(res).bpm).toBeCloseTo(bpm, 0);
  });
});

describe('midi', () => {
  it('exports and re-imports a MIDI file', () => {
    const notes = [note(60, 0, 0.5, 0.8), note(64, 0.5, 0.5, 0.6), note(67, 1, 1, 1)];
    const bytes = exportMidi([{ id: 't', name: 'Lead', notes }], 140);
    const { bpm, tracks } = importMidi(bytes);
    expect(bpm).toBeCloseTo(140);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('Lead');
    expect(tracks[0].notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    tracks[0].notes.forEach((n, i) => {
      expect(n.start).toBeCloseTo(notes[i].start, 2);
      expect(n.duration).toBeCloseTo(notes[i].duration, 2);
      expect(n.velocity).toBeCloseTo(notes[i].velocity, 1);
    });
  });

  it('quantizes to a 1/16 grid', () => {
    const q = quantize([note(60, 0.13, 0.2), note(62, 0.49, 0.1)], 120, 16);
    expect(q[0].start).toBeCloseTo(0.125);
    expect(q[1].start).toBeCloseTo(0.5);
    expect(q[0].duration).toBeCloseTo(0.25);
  });

  it('splits chords into voices, monophonizes, legatos and merges', () => {
    const chordy = [note(60, 0, 1), note(64, 0, 1), note(67, 0, 1), note(62, 1, 1), note(65, 1, 1)];
    const voices = splitVoices(chordy, 3);
    expect(voices[0].map((n) => n.pitch)).toEqual([67, 65]);
    expect(voices[2].map((n) => n.pitch)).toEqual([60]);
    expect(monophonize(chordy).map((n) => n.pitch)).toEqual([67, 65]);
    const l = legato([note(60, 0, 0.1), note(62, 0.5, 0.1)]);
    expect(l[0].duration).toBeCloseTo(0.5);
    expect(mergeRepeats([note(60, 0, 0.2), note(60, 0.21, 0.2)], 0.02)).toHaveLength(1);
  });
});

describe('sampler (Sound Applier)', () => {
  it('pitches a 440 Hz sample to the requested notes', () => {
    const src = sine(440, 1);
    const sample = createSample('src', 0, 1, { rootPitch: 69, sustain: 'cut' });
    expect(noteRate(sample, 81)).toBeCloseTo(2);
    const out = renderTrack([note(81, 0, 0.4), note(64, 0.5, 0.4)], src, sample, { sampleRate: SR, channels: 1 });
    const a = { sampleRate: SR, channels: [out.channels[0].slice(0.05 * SR, 0.35 * SR)] };
    const b = { sampleRate: SR, channels: [out.channels[0].slice(0.55 * SR, 0.85 * SR)] };
    expect(detectRootPitch(a)!.midi).toBeCloseTo(81, 0);
    expect(detectRootPitch(b)!.midi).toBeCloseTo(64, 0);
    // silence between notes (cut + release)
    expect(rms(out.channels[0], 0.46 * SR, 0.49 * SR)).toBeLessThan(0.01);
  });

  it('fixed mode keeps pitch, loop mode sustains past sample length', () => {
    const src = sine(440, 0.2);
    const fixed = createSample('s', 0, 0.2, { pitchMode: 'fixed' });
    expect(noteRate(fixed, 30)).toBe(1);
    const loop = createSample('s', 0, 0.2, { rootPitch: 69, sustain: 'loop' });
    const out = renderTrack([note(69, 0, 1)], src, loop, { sampleRate: SR, channels: 1 });
    expect(rms(out.channels[0], 0.7 * SR, 0.9 * SR)).toBeGreaterThan(0.2);
  });

  it('mixes a project with effects', async () => {
    const project = createProject();
    project.sampleRate = SR;
    const sample = createSample('src', 0, 0.5, { rootPitch: 69 });
    project.samples.push(sample);
    project.tracks.push(createTrack('lead', { sampleId: sample.id, notes: [note(69, 0, 0.5), note(72, 0.5, 0.5)] }));
    project.masterEffects.push(createEffect('reverb', { mix: 0.2 }));
    const { master, stems } = await mixProject(project, async () => sine(440, 1));
    expect(master.channels).toHaveLength(2);
    expect(durationOf(master)).toBeGreaterThan(1);
    expect(Object.keys(stems)).toHaveLength(1);
    expect(peak(master)).toBeLessThanOrEqual(1);
  });
});

describe('effects (Sound Effector)', () => {
  it('every effect runs and returns finite audio', () => {
    const src = sine(440, 0.3);
    for (const type of Object.keys(EFFECTS) as (keyof typeof EFFECTS)[]) {
      const out = applyEffects(src, [createEffect(type)]);
      expect(lengthOf(out), type).toBeGreaterThan(0);
      for (const ch of out.channels) for (const v of ch) expect(Number.isFinite(v), type).toBe(true);
    }
  });

  it('low-pass attenuates highs but keeps lows', () => {
    const lp = createEffect('lowpass', { freq: 500 });
    expect(rms(applyEffects(sine(5000, 0.3), [lp]).channels[0])).toBeLessThan(0.02);
    expect(rms(applyEffects(sine(100, 0.3), [lp]).channels[0])).toBeGreaterThan(0.3);
    const c = biquadCoefs('peaking', SR, 1000, 1, 0);
    expect(c.b0).toBeCloseTo(1);
  });

  it('delay produces an echo at the delay time', () => {
    const impulse = createPcm(SR, 1, SR);
    impulse.channels[0][0] = 1;
    const out = applyEffects(impulse, [createEffect('delay', { time: 0.25, feedback: 0, mix: 0.5 })]);
    expect(out.channels[0][Math.round(0.25 * SR)]).toBeCloseTo(0.5);
  });

  it('stutter repeats the head', () => {
    const out = applyEffects(sine(440, 0.5), [createEffect('stutter', { length: 0.1, repeats: 4 })]);
    expect(durationOf(out)).toBeCloseTo(0.8, 2);
  });

  it('disabled effects are bypassed', () => {
    const src = sine(440, 0.1);
    const fx = { ...createEffect('gain', { db: -40 }), enabled: false };
    expect(applyEffects(src, [fx])).toBe(src);
  });
});

describe('video synchronizer', () => {
  const assets = [{ id: 'vid', kind: 'video' as const, duration: 10 }, { id: 'aud', kind: 'audio' as const, duration: 10 }];
  const sample = createSample('vid', 2, 3, { rootPitch: 60 });
  const audioSample = createSample('aud', 0, 1, { rootPitch: 60 });
  const tracks = [
    createTrack('lead', { sampleId: sample.id, notes: [note(60, 0, 0.5), note(72, 1, 0.5)] }),
    createTrack('bass', { sampleId: audioSample.id, notes: [note(36, 0, 1)] }),
  ];

  it('creates one event per note on video tracks only, locked to audio rate', () => {
    const ev = buildSyncEvents({ tracks, samples: [sample, audioSample], assets, settings: DEFAULT_SYNC });
    expect(ev).toHaveLength(2);
    expect(ev[0].rate).toBe(1);
    expect(ev[1].rate).toBeCloseTo(2);
    expect(ev[0].flipX).toBe(false);
    expect(ev[1].flipX).toBe(true); // alternate flip
    // held until next note
    expect(ev[0].end).toBeCloseTo(1);
  });

  it('maps timeline time to source time (rate, hold, reverse, loop)', () => {
    const [e0, e1] = buildSyncEvents({ tracks, samples: [sample, audioSample], assets, settings: DEFAULT_SYNC });
    expect(sourceTimeAt(e0, 0.25)).toBeCloseTo(2.25);
    expect(sourceTimeAt(e1, 1.25)).toBeCloseTo(2.5); // 2x speed
    expect(sourceTimeAt({ ...e1, end: 3 }, 1.9)).toBeCloseTo(3, 2); // held on last frame
    expect(sourceTimeAt({ ...e0, reverse: true }, 0.25)).toBeCloseTo(2.75, 2);
    expect(sourceTimeAt({ ...e0, overrun: 'loop' }, 0.75 / 0.5)).toBeNull(); // outside event
    expect(sourceTimeAt({ ...e0, end: 5, overrun: 'loop' }, 1.25)).toBeCloseTo(2.25);
    expect(activeAt([e0, e1], 1.1).map((a) => a.ev)).toEqual([e1]);
  });

  it('lays out grids and lists the frames to decode', () => {
    const r = layoutRects('grid', 3);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(r[2].x).toBeCloseTo(0.25); // centred last row
    const ev = buildSyncEvents({ tracks, samples: [sample, audioSample], assets, settings: DEFAULT_SYNC });
    const need = framesNeeded(ev, 0, 1, 10, () => 30);
    expect([...need.keys()]).toEqual(['vid']);
    expect(need.get('vid')!.length).toBe(10);
  });
});

describe('tempo grid from notes', () => {
  it('recovers BPM and offset from jittered notes', async () => {
    const { estimateGrid } = await import('../src/core/midi/midi');
    const bpm = 165.5;
    const g = 60 / bpm / 4;
    const rng = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.008; // ±8 ms
    const steps = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14, 16, 19, 20, 22, 24, 26, 28, 30, 32, 35, 36, 40, 44, 46, 48];
    const notes = steps.map((k, i) => note(60 + (i % 5), 1.6 + k * g + rng(i), g));
    const r = estimateGrid(notes)!;
    expect(r.bpm).toBeCloseTo(bpm, 0);
    expect(Math.abs(r.offset - 1.6)).toBeLessThan(0.012);
    expect(r.stepError).toBeLessThan(0.15);
  });
});

describe('video scenes', () => {
  it('splits events at scene changes, re-lays them out and hides unlisted tracks', async () => {
    const { applyScenes, sceneRects } = await import('../src/core/video/timeline');
    const ev = (trackId: string, start: number, end: number) => ({ sourceId: 'v', trackId, start, end, sourceIn: 1, sourceLoopEnd: 3, rate: 1, overrun: 'hold' as const, layer: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, punch: 1.1, flash: 0.3 });
    const scenes = [
      { id: 's1', from: 0, layout: 'columns' as const, order: ['a', 'b'] },
      { id: 's2', from: 2, layout: 'focus' as const, order: ['b', 'a', 'c'] },
      { id: 's3', from: 4, layout: 'single' as const, order: ['c'] },
    ];
    const out = applyScenes([ev('a', 1, 3), ev('b', 0, 5), ev('c', 0, 6)], scenes);
    const a = out.filter((e) => e.trackId === 'a');
    expect(a.map((e) => [e.start, e.end])).toEqual([[1, 2], [2, 3]]);
    expect(a[0].rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(a[1].sourceIn).toBeCloseTo(2); // continues where it was (1 + 1 s)
    expect(a[1].punch).toBe(1); // no re-trigger on the cut
    expect(out.filter((e) => e.trackId === 'b').map((e) => [e.start, e.end])).toEqual([[0, 2], [2, 4]]); // hidden in s3
    const c = out.filter((e) => e.trackId === 'c');
    expect(c.map((e) => [e.start, e.end])).toEqual([[2, 4], [4, 6]]); // hidden in s1
    expect(c[1].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const f = sceneRects(scenes[1]);
    expect(f.b).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(f.a.x).toBeGreaterThanOrEqual(0.5);
  });
});

describe('loudness & mix helpers', () => {
  it('measures BS.1770 loudness of a reference tone', async () => {
    const { measureLoudness } = await import('../src/core/render/loudness');
    // 997 Hz sine, amplitude 0.1 → −23.0 LUFS (stereo: +3 dB → −20.0)
    const mono = sine(997, 5, 48000, 0.1);
    expect(measureLoudness(mono).integrated).toBeCloseTo(-23.0, 0);
    const stereo = { sampleRate: 48000, channels: [mono.channels[0], mono.channels[0]] };
    expect(measureLoudness(stereo).integrated).toBeCloseTo(-20.0, 0);
    expect(measureLoudness(mono).truePeak).toBeCloseTo(-20, 0);
  });

  it('normalizes to a loudness target and limits peaks', async () => {
    const { measureLoudness, normalizeLoudness } = await import('../src/core/render/loudness');
    const p = sine(440, 4, 48000, 0.05);
    for (let i = 0; i < 2000; i++) p.channels[0][48000 + i] = Math.sin(i) * 0.9; // a loud transient
    const { pcm } = normalizeLoudness(p, -14, -1);
    const m = measureLoudness(pcm);
    expect(m.integrated).toBeCloseTo(-14, 0);
    expect(peak(pcm)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-4);
  });

  it('auto-levels tracks to equal loudness (plus offsets)', async () => {
    const { autoLevel } = await import('../src/core/render/mix');
    const project = createProject();
    project.sampleRate = 48000;
    const s = createSample('src', 0, 0.5, { rootPitch: 69 });
    project.samples.push(s);
    const notes = [note(69, 0, 0.5), note(72, 0.5, 0.5), note(76, 1, 0.5)];
    project.tracks.push(createTrack('loud', { sampleId: s.id, notes, gain: 2 }), createTrack('quiet', { sampleId: s.id, notes, gain: 0.1, levelOffset: 3 }));
    const res = await autoLevel(project, async () => sine(440, 1, 48000, 0.5), { targetLufs: -20 });
    project.tracks.forEach((t) => (t.gain = res[t.id].gain));
    const { stems } = await mixProject(project, async () => sine(440, 1, 48000, 0.5));
    const { measureLoudness } = await import('../src/core/render/loudness');
    expect(measureLoudness(stems[project.tracks[0].id]).integrated).toBeCloseTo(-20, 0);
    expect(measureLoudness(stems[project.tracks[1].id]).integrated).toBeCloseTo(-17, 0);
  });
});

describe('self-check', () => {
  it('finds a detuned sample and proposes the right root fix', async () => {
    const { checkProject } = await import('../src/core/render/check');
    const project = createProject();
    project.sampleRate = 44100;
    // the source is 440 Hz but the sample claims root A4 +0: make the source 30 cents sharp instead
    const sharp = sine(440 * Math.pow(2, 0.3 / 12), 1);
    const s = createSample('src', 0, 1, { rootPitch: 69, sustain: 'cut' });
    project.samples.push(s);
    project.tracks.push(createTrack('lead', { sampleId: s.id, notes: [note(69, 0, 0.4), note(72, 0.5, 0.4), note(76, 1, 0.4), note(74, 1.5, 0.4)] }));
    const res = await checkProject(project, async () => sharp);
    const t = res.tracks[0];
    expect(t.pitch!.checked).toBe(4);
    expect(t.fixCents).toBeGreaterThan(20);
    expect(t.fixCents).toBeLessThan(40);
    // apply the fix → clean
    project.samples[0].rootCents = t.fixCents;
    const again = await checkProject(project, async () => sharp);
    expect(again.tracks[0].issues).toEqual([]);
    expect(again.tracks[0].midiMatch).toBeGreaterThan(0.8);
  });
});

describe('drum kit', () => {
  it('classifies kick, snare and hat transients', async () => {
    const { findDrumHits } = await import('../src/core/analysis/drums');
    const sr = 44100;
    const p = createPcm(sr, 1, sr * 3);
    const x = p.channels[0];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const put = (t: number, f: (i: number) => number, len: number) => {
      for (let i = 0; i < len * sr; i++) x[Math.round(t * sr) + i] += f(i);
    };
    put(0.5, (i) => Math.sin((2 * Math.PI * 55 * i) / sr) * Math.exp(-i / (0.08 * sr)) * 0.9, 0.3); // kick
    put(1.3, (i) => (rnd() * 0.6 + Math.sin((2 * Math.PI * 200 * i) / sr) * 0.2) * Math.exp(-i / (0.05 * sr)), 0.25); // snare
    let prev = 0;
    put(2.1, (i) => {
      const n = rnd();
      const hp = n - prev; // crude high-pass → hat
      prev = n;
      return hp * 0.5 * Math.exp(-i / (0.012 * sr));
    }, 0.08);
    const hits = findDrumHits(p, { perKind: 1 });
    expect(hits.kick[0].time).toBeCloseTo(0.5, 1);
    expect(hits.snare[0].time).toBeCloseTo(1.3, 1);
    expect(hits.hat[0].time).toBeCloseTo(2.1, 1);
  });

  it('generates patterns on the grid', async () => {
    const { drumPattern } = await import('../src/core/analysis/drums');
    const d = drumPattern('four', { bpm: 120, from: 1.0, to: 3.0, gridOffset: 0.5 });
    // grid lines every 0.125 s from 0.5; bars start at 0.5, 2.5 → kicks every beat (0.5 s)
    expect(d.kick.map((n) => n.start)).toEqual([1.0, 1.5, 2.0, 2.5].map((t) => expect.closeTo(t, 6)) as never);
    expect(d.snare.map((n) => +n.start.toFixed(3))).toEqual([1.0, 2.0]);
    expect(d.hat.length).toBe(4);
  });
});

describe('video effects, pulses and text', () => {
  it('applies flip modes, rotation, shake decay and held greyscale', async () => {
    const { buildSyncEvents, visualState, activeAt, DEFAULT_SYNC } = await import('../src/core/video/timeline');
    const s = createSample('v', 0, 0.2, { rootPitch: 60 });
    const tr = createTrack('t', { sampleId: s.id, notes: [note(60, 0, 0.5), note(60, 1, 0.5), note(60, 2, 0.5)] });
    const settings = { ...DEFAULT_SYNC, flipMode: 'vertical' as const, rotate: 8, shake: 0.05, greyHeld: true };
    const ev = buildSyncEvents({ tracks: [tr], samples: [s], assets: [{ id: 'v', kind: 'video', duration: 1 }], settings });
    expect(ev.map((e) => !!e.flipY)).toEqual([false, true, false]);
    expect(ev.map((e) => e.rotate)).toEqual([8, -8, 8]);
    const at = (t: number) => visualState(activeAt(ev, t)[0]);
    expect(Math.abs(at(0.01).dx) + Math.abs(at(0.01).dy)).toBeGreaterThan(0);
    expect(Math.abs(at(0.9).dx)).toBeLessThan(0.001); // decayed
    expect(at(0.1).grey).toBe(false); // sounding (0.2 s sample)
    expect(at(0.7).grey).toBe(true); // holding the last frame
    expect(at(0.01)).toEqual(at(0.01)); // deterministic
  });

  it('builds screen pulses from chosen tracks', async () => {
    const { projectPulses, pulseState } = await import('../src/core/video/timeline');
    const p = createProject();
    const kick = createTrack('kick', { notes: [note(60, 1, 0.1, 1), note(60, 2, 0.1, 0.5)] });
    p.tracks.push(kick, createTrack('other', { notes: [note(60, 1.5, 0.1)] }));
    p.videoSync = { ...p.videoSync, pulseTrackIds: [kick.id], pulseFlash: 0.4, pulseZoom: 0.1 };
    const pulses = projectPulses(p);
    expect(pulses.map((x) => x.time)).toEqual([1, 2]);
    expect(pulseState(pulses, 1.0, p.videoSync).flash).toBeCloseTo(0.4);
    expect(pulseState(pulses, 1.5, p.videoSync).flash).toBeLessThan(0.01);
    expect(pulseState(pulses, 2.0, p.videoSync).zoom).toBeCloseTo(1.05);
  });

  it('animates text overlays', async () => {
    const { textState } = await import('../src/core/video/text');
    const o = { id: 'x', text: 'こんにちは', start: 1, end: 3, x: 0.5, y: 0.5, size: 0.1, color: '#fff' };
    expect(textState({ ...o, anim: 'fade' }, 0.5)).toBeNull();
    expect(textState({ ...o, anim: 'fade' }, 1.1)!.alpha).toBeCloseTo(0.4);
    expect(textState({ ...o, anim: 'fade' }, 2)!.alpha).toBe(1);
    expect(textState({ ...o, anim: 'type' }, 1.2)!.chars).toBeLessThan(5);
    expect(textState({ ...o, anim: 'type' }, 2.5)!.chars).toBe(5); // counts characters, not UTF-16 units
    expect(textState({ ...o, anim: 'pop' }, 1.05)!.scale).toBeLessThan(1);
  });
});

describe('loudness normalisation with heavy limiting', () => {
  it('still lands on a loud target when the limiter works hard', async () => {
    const { measureLoudness, normalizeLoudness } = await import('../src/core/render/loudness');
    // spiky material: quiet tone + loud clicks every 0.25 s (high crest factor)
    const p = sine(220, 6, 48000, 0.05);
    for (let t = 0; t < 6; t += 0.25) for (let i = 0; i < 400; i++) p.channels[0][Math.round(t * 48000) + i] += Math.exp(-i / 80) * 0.9;
    const { pcm } = normalizeLoudness(p, -9, -1.5);
    expect(measureLoudness(pcm).integrated).toBeCloseTo(-9, 0);
    expect(peak(pcm)).toBeLessThanOrEqual(Math.pow(10, -1.5 / 20) + 1e-4);
  });
});
