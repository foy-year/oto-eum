import { type Project, type Sample, type NoteTrack, uid } from './types';
import { DEFAULT_SYNC } from './video/timeline';

export function createProject(name = 'Untitled 音MAD'): Project {
  return {
    id: uid('p'),
    name,
    bpm: 120,
    sampleRate: 48000,
    tracks: [],
    samples: [],
    masterEffects: [],
    videoSync: { ...DEFAULT_SYNC },
    videoClips: [],
    backingGain: 1,
  };
}

export function createSample(sourceId: string, start: number, end: number, init: Partial<Sample> = {}): Sample {
  return {
    id: uid('s'),
    name: init.name ?? 'Sample',
    sourceId,
    start,
    end,
    rootPitch: 60,
    gain: 1,
    reverse: false,
    fadeIn: 0.002,
    fadeOut: 0.01,
    pitchMode: 'resample',
    sustain: 'cut',
    release: 0.03,
    ...init,
  };
}

export function createTrack(name: string, init: Partial<NoteTrack> = {}): NoteTrack {
  return { id: uid('t'), name, notes: [], gain: 1, pan: 0, effects: [], ...init };
}
