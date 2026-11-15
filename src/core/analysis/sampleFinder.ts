/**
 * Sample finder: pitched syllables in a source, ranked for 音MAD use.
 *
 * For every voiced stretch it finds the steadiest part (the vowel — good for
 * looping / held notes) and the syllable around it (consonant onset + vowel —
 * good for one-shots), with its root note and how steady it is.
 */
import { type Pcm, slice, rms, toMono } from '../audio/pcm';
import { hzToMidi } from './pitch';
import { analyzeF0 } from '../render/psola';

export interface SyllableCandidate {
  /** Whole syllable (with the consonant onset), seconds. */
  start: number;
  end: number;
  /** Steady (vowel) part, seconds. */
  steadyStart: number;
  steadyEnd: number;
  /** Median pitch of the steady part (fractional MIDI). */
  rootMidi: number;
  /** Pitch range (10th–90th percentile) inside the steady part, semitones. */
  spread: number;
  loudness: number;
  /** 0..1, higher = better sample. */
  score: number;
}

export interface FinderOptions {
  minSteady?: number;
  /** Max pitch deviation from the running median inside a steady part (semitones). */
  tolerance?: number;
  /** Max consonant lead-in to include before the vowel (s). */
  maxOnset?: number;
  minHz?: number;
  maxHz?: number;
  limit?: number;
}

export function findSyllables(pcm: Pcm, opts: FinderOptions = {}): SyllableCandidate[] {
  const minSteady = opts.minSteady ?? 0.06;
  const tol = opts.tolerance ?? 0.4;
  const maxOnset = opts.maxOnset ?? 0.08;
  const tr = analyzeF0(pcm, { minHz: opts.minHz ?? 70, maxHz: opts.maxHz ?? 1000 });
  const midi = Array.from(tr.f0, (f) => (f > 0 ? hzToMidi(f) : NaN));
  const tOf = (i: number) => tr.t0 + i * tr.hop - tr.hop / 2;
  const mono = { sampleRate: pcm.sampleRate, channels: [toMono(pcm)] };
  const total = mono.channels[0].length / pcm.sampleRate;
  const peakLoud = rms(mono.channels[0]) * 4 || 1;
  const out: SyllableCandidate[] = [];

  let i = 0;
  while (i < midi.length) {
    if (Number.isNaN(midi[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < midi.length && !Number.isNaN(midi[j + 1])) j++;
    // voiced run [i, j]: longest sub-run whose pitch stays within ±tol of its median
    let bestA = i;
    let bestB = i - 1;
    for (let a = i; a <= j; a++) {
      const win: number[] = [];
      let b = a;
      for (; b <= j; b++) {
        win.push(midi[b]);
        const med = win.slice().sort((x, y) => x - y)[win.length >> 1];
        if (win.some((m) => Math.abs(m - med) > tol)) break;
      }
      if (b - 1 - a > bestB - bestA) [bestA, bestB] = [a, b - 1];
      if (bestB === j) break;
    }
    const steadyStart = tOf(bestA);
    const steadyEnd = tOf(bestB + 1);
    if (steadyEnd - steadyStart >= minSteady) {
      const ms = midi.slice(bestA, bestB + 1).sort((x, y) => x - y);
      const rootMidi = ms[ms.length >> 1];
      const spread = ms[Math.floor(ms.length * 0.9)] - ms[Math.floor(ms.length * 0.1)];
      // syllable start: back from the voiced start to the energy onset (consonant), bounded
      const runStart = tOf(i);
      let start = Math.max(0, runStart - maxOnset);
      const lead = slice(mono, start, runStart).channels[0];
      const step = Math.max(1, Math.round(0.005 * pcm.sampleRate));
      const floor = rms(slice(mono, steadyStart, steadyEnd).channels[0]) * 0.12;
      for (let k = lead.length - step; k >= 0; k -= step) {
        if (rms(lead, k, k + step) < floor) {
          start = start + (k + step) / pcm.sampleRate;
          break;
        }
      }
      const end = Math.min(total, tOf(j + 1));
      const loudness = rms(slice(mono, steadyStart, steadyEnd).channels[0]);
      const dur = steadyEnd - steadyStart;
      const score = Math.min(1, dur / 0.25) * 0.4 + Math.max(0, 1 - spread / tol) * 0.3 + Math.min(1, loudness / peakLoud) * 0.3;
      out.push({ start, end, steadyStart, steadyEnd, rootMidi, spread, loudness, score });
    }
    i = j + 1;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 60);
}
