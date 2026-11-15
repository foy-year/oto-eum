/**
 * MIDI file I/O and note-editing operations (the MIDI editor's engine).
 */
import { Midi } from '@tonejs/midi';
import { type Note, type NoteTrack, uid } from '../types';

export function importMidi(data: ArrayBuffer | Uint8Array): { bpm: number; tracks: NoteTrack[] } {
  const midi = new Midi(data instanceof Uint8Array ? data : new Uint8Array(data));
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const tracks: NoteTrack[] = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => ({
      id: uid('t'),
      name: t.name || t.instrument?.name || `Track ${i + 1}`,
      notes: t.notes.map((n) => ({ id: uid('n'), pitch: n.midi, start: n.time, duration: n.duration, velocity: n.velocity })),
    }));
  return { bpm, tracks };
}

export function exportMidi(tracks: NoteTrack[], bpm = 120, name = 'oto-eum'): Uint8Array {
  const midi = new Midi();
  midi.name = name;
  midi.header.setTempo(bpm);
  tracks.forEach((t, i) => {
    const tr = midi.addTrack();
    tr.name = t.name;
    tr.channel = i % 16 === 9 ? (i + 1) % 16 : i % 16;
    for (const n of t.notes) {
      tr.addNote({ midi: clampPitch(Math.round(n.pitch)), time: Math.max(0, n.start), duration: Math.max(1e-3, n.duration), velocity: clamp01(n.velocity) });
    }
  });
  return midi.toArray();
}

// ---------------------------------------------------------------------------
// Editing operations. All are pure: they return new arrays.
// ---------------------------------------------------------------------------

export const beatSeconds = (bpm: number) => 60 / bpm;

/** Grid size in seconds for a division of a whole note (4 = quarter, 16 = sixteenth). */
export const gridSeconds = (bpm: number, division: number) => (4 * 60) / bpm / division;

export function sortNotes(notes: Note[]): Note[] {
  return notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * Snap starts (and optionally ends) to a grid. `strength` 0..1 allows partial
 * ("humanised") quantisation.
 */
export function quantize(notes: Note[], bpm: number, division = 16, opts: { strength?: number; ends?: boolean; offset?: number } = {}): Note[] {
  const g = gridSeconds(bpm, division);
  const s = opts.strength ?? 1;
  const off = opts.offset ?? 0;
  const snap = (t: number) => off + Math.round((t - off) / g) * g;
  return notes.map((n) => {
    const start = n.start + (snap(n.start) - n.start) * s;
    let end = n.start + n.duration;
    if (opts.ends ?? true) end = end + (Math.max(snap(end), snap(n.start) + g) - end) * s;
    return { ...n, start, duration: Math.max(g * 0.25, end - start) };
  });
}

export function transpose(notes: Note[], semitones: number): Note[] {
  return notes.map((n) => ({ ...n, pitch: clampPitch(n.pitch + semitones) }));
}

export function shiftTime(notes: Note[], seconds: number): Note[] {
  return notes.map((n) => ({ ...n, start: Math.max(0, n.start + seconds) }));
}

/** Scale timing around t=0 (e.g. tempo change, half-time). */
export function stretchTime(notes: Note[], factor: number): Note[] {
  return notes.map((n) => ({ ...n, start: n.start * factor, duration: n.duration * factor }));
}

/** Extend each note to the next note's start (monophonic legato). */
export function legato(notes: Note[], maxGap = Infinity): Note[] {
  const s = sortNotes(notes);
  return s.map((n, i) => {
    const next = s.slice(i + 1).find((m) => m.start > n.start + 1e-6);
    if (!next) return n;
    const gap = next.start - (n.start + n.duration);
    return gap > 0 && gap <= maxGap ? { ...n, duration: next.start - n.start } : n;
  });
}

/** Force monophony: keep the highest (or lowest) note when notes overlap. */
export function monophonize(notes: Note[], keep: 'highest' | 'lowest' | 'latest' = 'highest'): Note[] {
  const s = sortNotes(notes);
  const out: Note[] = [];
  for (const n of s) {
    const prev = out[out.length - 1];
    if (!prev || prev.start + prev.duration <= n.start + 1e-6) {
      out.push({ ...n });
      continue;
    }
    if (Math.abs(prev.start - n.start) < 1e-3) {
      const better = keep === 'highest' ? n.pitch > prev.pitch : keep === 'lowest' ? n.pitch < prev.pitch : true;
      if (better) out[out.length - 1] = { ...n };
    } else {
      prev.duration = n.start - prev.start; // cut previous
      out.push({ ...n });
    }
  }
  return out;
}

/** Remove very short / quiet notes (cleanup after transcription). */
export function filterNotes(notes: Note[], opts: { minDuration?: number; minVelocity?: number; minPitch?: number; maxPitch?: number }): Note[] {
  return notes.filter(
    (n) =>
      n.duration >= (opts.minDuration ?? 0) &&
      n.velocity >= (opts.minVelocity ?? 0) &&
      n.pitch >= (opts.minPitch ?? 0) &&
      n.pitch <= (opts.maxPitch ?? 127),
  );
}

/** Merge consecutive same-pitch notes separated by less than `gap` seconds. */
export function mergeRepeats(notes: Note[], gap = 0.02): Note[] {
  const byPitch = new Map<number, Note[]>();
  for (const n of sortNotes(notes)) {
    const arr = byPitch.get(n.pitch) ?? [];
    const last = arr[arr.length - 1];
    if (last && n.start - (last.start + last.duration) <= gap) {
      last.duration = Math.max(last.duration, n.start + n.duration - last.start);
      last.velocity = Math.max(last.velocity, n.velocity);
    } else arr.push({ ...n });
    byPitch.set(n.pitch, arr);
  }
  return sortNotes([...byPitch.values()].flat());
}

/**
 * Split polyphonic notes into separate voices (lowest → bass, highest →
 * melody...). Very useful for 音MAD: each voice gets its own sample.
 */
export function splitVoices(notes: Note[], maxVoices = 4): Note[][] {
  const voices: Note[][] = Array.from({ length: maxVoices }, () => []);
  const s = sortNotes(notes);
  // group notes starting at (almost) the same time
  let i = 0;
  while (i < s.length) {
    const chord = [s[i]];
    let j = i + 1;
    while (j < s.length && s[j].start - s[i].start < 0.03) chord.push(s[j++]);
    chord.sort((a, b) => b.pitch - a.pitch); // top voice first
    chord.slice(0, maxVoices).forEach((n, v) => {
      const voice = voices[v];
      const prev = voice[voice.length - 1];
      if (prev && prev.start + prev.duration > n.start) prev.duration = Math.max(0.01, n.start - prev.start);
      voice.push({ ...n });
    });
    i = j;
  }
  return voices.filter((v) => v.length > 0);
}

export function setVelocity(notes: Note[], v: number | ((n: Note) => number)): Note[] {
  return notes.map((n) => ({ ...n, velocity: clamp01(typeof v === 'function' ? v(n) : v) }));
}

export function notesInRange(notes: Note[], t0: number, t1: number): Note[] {
  return notes.filter((n) => n.start < t1 && n.start + n.duration > t0);
}

export function endTime(tracks: NoteTrack[]): number {
  let e = 0;
  for (const t of tracks) for (const n of t.notes) e = Math.max(e, n.start + n.duration);
  return e;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampPitch = (p: number) => Math.max(0, Math.min(127, p));

/**
 * Tempo and grid from note timings (e.g. notes read from a video or
 * transcribed from audio): finds the 16th-note step that best explains the
 * inter-onset intervals, then least-squares fits the exact step and offset.
 * `offset` is the time of a grid line (use it as quantize's offset).
 */
export function estimateGrid(notes: Note[], opts: { minBpm?: number; maxBpm?: number } = {}): { bpm: number; offset: number; stepError: number } | null {
  const minBpm = opts.minBpm ?? 70;
  const maxBpm = opts.maxBpm ?? 200;
  const starts = [...new Set(notes.map((n) => Math.round(n.start * 1000) / 1000))].sort((a, b) => a - b);
  if (starts.length < 8) return null;
  // phase coherence of all starts on a grid of step g (sharp: the whole time span counts)
  const coherence = (g: number) => {
    let re = 0;
    let im = 0;
    for (const t of starts) {
      re += Math.cos((2 * Math.PI * t) / g);
      im += Math.sin((2 * Math.PI * t) / g);
    }
    return Math.hypot(re, im) / starts.length;
  };
  const gMin = 60 / maxBpm / 4 / 2;
  const gMax = 60 / minBpm / 4;
  const span = starts[starts.length - 1] - starts[0];
  // step resolution fine enough that the grid drifts < 1/8 step over the whole span
  const ratio = 1 + Math.min(0.002, gMin / (8 * Math.max(span, 1)));
  const scores: Array<[number, number]> = [];
  let best = 0;
  for (let gg = gMin; gg <= gMax; gg *= ratio) {
    const sc = coherence(gg);
    scores.push([gg, sc]);
    best = Math.max(best, sc);
  }
  // the largest step that explains (almost) as well as the best: 16ths, not 32nds/64ths
  let g = Math.max(...scores.filter(([, sc]) => sc >= best * 0.9).map(([gg]) => gg));
  // local refinement around it
  let gb = g;
  let sb = coherence(g);
  for (let gg = g * 0.995; gg <= g * 1.005; gg *= 1.00005) {
    const sc = coherence(gg);
    if (sc > sb) [sb, gb] = [sc, gg];
  }
  g = gb;
  // offset from the phase of the starts on this grid, then least squares on the integer steps
  let re = 0;
  let im = 0;
  for (const s of starts) {
    re += Math.cos((2 * Math.PI * s) / g);
    im += Math.sin((2 * Math.PI * s) / g);
  }
  let offset = ((Math.atan2(im, re) / (2 * Math.PI)) * g + g) % g;
  for (let iter = 0; iter < 3; iter++) {
    const k = starts.map((s) => Math.round((s - offset) / g));
    const n = k.length;
    const mk = k.reduce((a, b) => a + b, 0) / n;
    const ms = starts.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    k.forEach((ki, i) => {
      num += (ki - mk) * (starts[i] - ms);
      den += (ki - mk) ** 2;
    });
    if (!den) break;
    g = num / den;
    offset = ms - g * mk;
  }
  const err = Math.sqrt(starts.reduce((a, s) => a + (((s - offset) / g - Math.round((s - offset) / g)) ** 2), 0) / starts.length);
  let bpm = 60 / (g * 4);
  while (bpm < minBpm) bpm *= 2;
  while (bpm >= maxBpm * 1.0001) bpm /= 2;
  const first = starts[0];
  offset = offset + Math.floor((first - offset) / g + 0.5) * g; // grid line at/near the first note
  return { bpm, offset, stepError: err };
}
