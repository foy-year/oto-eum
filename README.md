# oto-eum · 音MAD toolkit

A browser-based workstation for **音MAD / YTPMV** creators: cut sounds out of
videos, extract or write MIDI, play the sounds as an instrument on that MIDI,
add effects, and render a video whose picture is **sample-locked** to the
audio.

Everything runs client-side (Web Audio, WebCodecs, TF.js). Uploaded sources
stay in the user's browser (IndexedDB) — no server, no hosting cost, and no
redistribution of copyrighted source material.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Node)
npm run test:e2e   # real-browser pipeline + UI smoke test (Playwright/Chromium)
npm run build
```

## Tools

| # | Tool | What it does |
|---|------|--------------|
| 1 | **Library** | Upload audio/video (mp3, wav, ogg, flac, m4a, mp4, webm, mov, mkv…). Probes duration, resolution, fps. Mark a file as backing audio. |
| 2 | **Sound Editor** | Waveform with region selection → create *samples* (non-destructive regions). Auto pitch detection (YIN) for the root note, onset detection + auto-slicing, reverse, fades, gain, pitch mode (`resample` = classic 音MAD pitching / `fixed`), sustain (`cut` / one-shot / `loop`), audition at any note, bounce to a new file. |
| 3 | **MIDI Extractor** | Audio/video → MIDI. **Polyphonic**: Spotify Basic Pitch (neural, in-browser). **Monophonic**: YIN tracker (vocals, speech-melody "tuning", lead lines). Region-limited analysis, Hz limits, top-melody-only, split chords into voices/tracks, BPM estimation. Also imports `.mid`. |
| 4 | **MIDI Editor** | Piano roll: draw/move/resize/delete, multi-select, keyboard transpose, ghost notes of other tracks, grid/snap, zoom. Ops: quantize (full/50%), transpose, octave, legato, monophonize, merge repeats, velocity, split voices → tracks. Export `.mid` (one or all tracks). |
| 5 | **Sound Applier** | Assign a sample to each MIDI track; gain/pan/mute; mix with backing audio; render & export WAV. Pitching uses 4-point Hermite resampling. |
| 6 | **Sound Effector** | Effect chains on a **sample** (baked before pitching), a **track**, or the **master**: gain, pan, low/high/band-pass, EQ bell, shelves, distortion, bitcrusher, delay (ping-pong), reverb (Freeverb), chorus, compressor, tremolo, stutter, reverse, speed/pitch, normalize. Presets (telephone, lo-fi, chipmunk, stutter roll, hall…). |
| 7 | **Video Synchronizer** | Every note of a track whose sample was cut from a video re-triggers that video region **at the same rate as the audio** (an octave up = 2× speed picture). Layouts: single / grid / columns / rows. Alternate L/R flip, hue-by-pitch, zoom punch, flash, hold-last-frame. Real-time preview and frame-exact export to MP4 (H.264) or WebM (VP9) with audio. |
| 8 | **Video Editor** | Manual clips on layers above the synced video: timing, in/out, speed, position/size, flip, reverse, invert, hue, opacity. **Beat-cut generator**: cuts a video on every onset of the mix (sequential / random / restart). |

## Architecture

```
src/core/          UI-agnostic engine — pure TS, unit-tested in Node
  types.ts           JSON-serialisable project model (tracks, samples, effects, clips)
  audio/pcm.ts       planar PCM container + DSP helpers (slice, resample, mix, fade…)
  audio/wav.ts       WAV encode/decode
  audio/decode.ts    browser: probe + decode any media (Web Audio → Mediabunny fallback)
  analysis/pitch.ts  YIN f0 tracking, root detection, contour → notes
  analysis/onset.ts  spectral-flux onsets, tempo estimation, slicing
  midi/midi.ts       .mid I/O + editing ops (quantize, legato, voices…)
  midi/transcribe.ts Basic Pitch (lazy-loaded TF.js) / YIN transcription
  render/sampler.ts  Sound Applier: sample-accurate note rendering
  render/effects.ts  pure-JS effect DSP + parameter specs (UI is generated from them)
  render/mix.ts      project mixdown
  video/timeline.ts  notes → VideoEvents (shares noteRate() with the sampler ⇒ A/V lock)
  video/frames.ts    WebCodecs frame cache (batched sorted decode → ImageBitmap LRU)
  video/compositor.ts draws one frame (layout, flip, hue, punch, flash)
  video/export.ts    offline, frame-exact encode via Mediabunny (MP4/WebM)
  storage/           MediaStore / ProjectStore interfaces + IndexedDB implementation
src/ui/            React UI (one panel per tool) — deliberately plain for now
tests/             vitest unit tests + Playwright e2e (tests/e2e)
```

Key design choice: **one timing function for sound and picture.** `noteRate()`
(`2^((pitch − root)/12)`) decides how fast the sample plays; the video timeline
uses the same function to decide which source frame to show. The e2e test
verifies this with a colour-coded video: the exported frame at every probed
time matches the frame the pitched audio is playing.

### Storage & a future server

`MediaStore` and `ProjectStore` are interfaces. To host uploads on a server
(sharing source packs, collaboration, cross-device projects) implement them
against an object store (S3/R2) + API; the rest of the app is unchanged.
Keep in mind that hosting third-party video/audio raises copyright/DMCA and
moderation obligations — the local-only default avoids that.

## Browser support

Needs WebCodecs (Chrome/Edge 94+, Safari 16.4+, Firefox 130+). MP4 export uses
H.264 + AAC where the browser can encode them (Chrome, Edge, Safari); otherwise
it falls back to Opus-in-MP4 or WebM.

## Roadmap

- Move heavy DSP / transcription into Web Workers (UI stays responsive on long songs)
- Source separation (vocals/drums/bass) before MIDI extraction
- Formant-preserving pitch shift & time-stretch (PSOLA/WSOLA) as an alternative to resampling
- Pitch-bend / vibrato from Basic Pitch contours; per-note sample choice (multi-sample instruments)
- Video: per-note crop/zoom keyframes, chroma key, more layouts, motion-tracked pan
- Multi-track timeline editor with drag & drop; undo/redo
- Project import/export as a single `.otoeum` bundle; optional cloud backend
- i18n (日本語 / 한국어 / Polski / Українська)

## Licences

App code: no licence chosen yet (add a LICENSE before publishing). Bundled model: Spotify Basic Pitch (Apache-2.0),
copied from `@spotify/basic-pitch` at build time.
