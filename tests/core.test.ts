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
