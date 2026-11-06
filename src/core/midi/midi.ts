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
