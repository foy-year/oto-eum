/**
 * Self-check of a render: is every track in tune, does it play its MIDI,
 * how loud is it, does it clip — plus the master and an optional reference.
 * Each finding comes with a concrete fix where one exists.
 */
import { type Pcm, peak } from '../audio/pcm';
import type { Project } from '../types';
import { chromaAgreement, compareRecordings, pitchAccuracy } from '../analysis/align';
import { measureLoudness, type LoudnessResult } from './loudness';
import { mixProject, type SourceLoader } from './mix';

export interface TrackCheck {
  trackId: string;
  name: string;
  notes: number;
  /** null for unpitched (fixed) samples. */
  pitch: { checked: number; medianError: number; within50cents: number; medianSigned: number } | null;
  /** −1..1 agreement of the rendered pitch classes with the track's MIDI (null if unpitched). */
  midiMatch: number | null;
  loudness: number;
  peakDb: number;
  issues: string[];
  /** Suggested rootCents change for the track's sample (fixes a constant detune). */
  fixCents?: number;
}

export interface ProjectCheck {
  tracks: TrackCheck[];
  master: LoudnessResult;
  reference?: { offset: number; agreement: number };
  issues: string[];
}

export async function checkProject(project: Project, load: SourceLoader, opts: { reference?: Pcm; onProgress?: (f: number) => void } = {}): Promise<ProjectCheck> {
  const { master, stems, loudness } = await mixProject(project, load);
  const tracks: TrackCheck[] = [];
  const list = project.tracks.filter((t) => stems[t.id]);
  list.forEach((t, i) => {
    opts.onProgress?.(i / Math.max(1, list.length));
    const st = stems[t.id];
    const sample = project.samples.find((s) => s.id === t.sampleId);
    const pitched = sample && sample.pitchMode !== 'fixed';
    const pitch = pitched ? pitchAccuracy(st, t.notes) : null;
    const midiMatch = pitched ? chromaAgreement(st, t.notes) : null;
    const L = measureLoudness(st).integrated;
    const pk = peak(st);
    const issues: string[] = [];
    let fixCents: number | undefined;
    if (pitch && pitch.checked >= 3) {
      if (pitch.medianError > 0.3) {
        issues.push(`out of tune by ${Math.round(pitch.medianSigned * 100)} cents`);
        if (pitch.within50cents < 0.5 || Math.abs(pitch.medianSigned) > 0.25) fixCents = Math.round(pitch.medianSigned * 100);
      } else if (pitch.within50cents < 0.7) issues.push('pitch is unsteady — try "Flatten pitch" on the sample');
    }
    if (midiMatch != null && midiMatch < 0.4) issues.push('weak match with its MIDI — sample may be noisy or unpitched (try pitch mode "fixed" or another sample)');
    if (pk > 1) issues.push(`clips (peak ${(20 * Math.log10(pk)).toFixed(1)} dB) — lower its gain`);
    tracks.push({ trackId: t.id, name: t.name, notes: t.notes.length, pitch, midiMatch, loudness: L, peakDb: pk > 0 ? 20 * Math.log10(pk) : -Infinity, issues, fixCents });
  });
  const issues: string[] = [];
  const Ls = tracks.map((t) => t.loudness).filter(Number.isFinite).sort((a, b) => a - b);
  const med = Ls[Ls.length >> 1];
  for (const t of tracks)
    if (Number.isFinite(t.loudness) && Number.isFinite(med) && t.loudness < med - 15) t.issues.push(`very quiet (${(t.loudness - med).toFixed(0)} LU vs. the other tracks) — try Auto-level`);
  if (loudness.truePeak > -0.1) issues.push(`master peaks at ${loudness.truePeak.toFixed(1)} dBTP — set a master loudness target (limiter) to avoid clipping on upload`);
  if (Number.isFinite(loudness.integrated) && loudness.integrated < -24) issues.push(`master is quiet (${loudness.integrated.toFixed(1)} LUFS) — try a −14 LUFS target`);
  const reference = opts.reference ? compareRecordings(master, opts.reference) : undefined;
  if (reference && reference.agreement < 0.3) issues.push(`low agreement with the reference (${Math.round(reference.agreement * 100)}%) — check the key/octave of the MIDI or the sample roots`);
  opts.onProgress?.(1);
  return { tracks, master: loudness, reference, issues };
}
