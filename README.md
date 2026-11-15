# oto-eum · 音MAD toolkit

A browser-based workstation for **音MAD / YTPMV** creators: cut sounds out of
videos, extract or write MIDI, play the sounds as an instrument on that MIDI,
add effects, and render a video whose picture is **sample-locked** to the
audio.

All media processing runs client-side (Web Audio, WebCodecs, TF.js). Storage
has two modes:

- **Local** (default): uploads stay in the user's browser (IndexedDB).
- **Cloud**: sign in to an oto-eum server (`server/`) to keep uploads online,
  use them on any device, share projects with collaborators, and publish
  **source packs** other creators can browse and reuse.

```bash
npm install
npm run dev        # frontend on http://localhost:5173
npm run server     # API server on http://localhost:8787 (data in ./data)
npm test           # unit + API tests (Node)
npm run test:e2e   # real-browser pipeline, UI smoke test, cloud flow (Playwright/Chromium)
npm run build
```

Requires Node ≥ 22.18 (the server runs TypeScript directly and uses the built-in SQLite).

## Tools

| # | Tool | What it does |
|---|------|--------------|
| 1 | **Library** | Upload audio/video (mp3, wav, ogg, flac, m4a, mp4, webm, mov, mkv…). Probes duration, resolution, fps. Mark a file as backing audio. |
| 2 | **Sound Editor** | Waveform with region selection → create *samples* (non-destructive regions). **Sample finder**: ranks pitched syllables in a source (thumbnail, root note, steadiness) → one-click one-shot or vowel loop. Auto root detection, onset detection + auto-slicing, reverse, fades, gain. **Tuning**: flatten pitch 50/100 % (PSOLA) with a pitch-curve view. Pitch modes: `resample` (classic 音MAD: faster = higher), `natural` (PSOLA: keeps speed and formants — voices stay voices), `fixed`. Sustain `cut` / one-shot / `loop`, audition at any note, bounce to a new file. |
| 3 | **MIDI Extractor** | **Piano-roll (MIDI) video reader**: drag the note area, auto-detect the row grid + note names (from the black/white key shading) and one track per colour, read the whole video (page flips, playhead), verify pitch/octave against the video's audio, set the tempo. Audio/video → MIDI: **polyphonic** Spotify Basic Pitch (neural, in-browser), **monophonic** YIN (vocals, speech-melody, lead lines). Region-limited analysis, Hz limits, top-melody-only, split chords into voices, BPM estimation, `.mid` import. |
| 4 | **MIDI Editor** | Piano roll: draw/move/resize/delete, multi-select, keyboard transpose, ghost notes of other tracks, grid/snap, zoom. Ops: quantize (full/50%), transpose, octave, legato, monophonize, merge repeats, velocity, split voices → tracks. **Detect tempo** (BPM + grid offset from the notes); grid and quantize follow it. Export `.mid` (one or all tracks). |
| 5 | **Sound Applier** | Assign a sample to each MIDI track; gain/pan/mute; mix with backing audio. **Auto-level** (equal loudness + per-track ±dB), **master loudness** target (−14 LUFS etc., true-peak limiter), loudness/peak readout (ITU-R BS.1770). Export WAV or M4A (AAC; WebM/Opus where AAC is unavailable). |
| 6 | **Sound Effector** | Effect chains on a **sample** (baked before pitching), a **track**, or the **master**: gain, pan, low/high/band-pass, EQ bell, shelves, distortion, bitcrusher, delay (ping-pong), reverb (Freeverb), chorus, compressor, tremolo, stutter, reverse, speed/pitch, normalize. Presets (telephone, lo-fi, chipmunk, stutter roll, hall…). |
| 7 | **Video Synchronizer** | Every note of a track whose sample was cut from a video re-triggers that video region **at the same rate as the audio** (an octave up = 2× speed picture). Layouts: single / grid / columns / rows. Alternate L/R flip, hue-by-pitch, zoom punch, flash, hold-last-frame. **Scenes**: change the layout over time (grid / focus / columns / rows / single / custom drag-and-resize boxes), per-scene visible tracks and order. Real-time preview and frame-exact export to MP4 (H.264) or WebM (VP9) with audio. |
| 8 | **Video Editor** | Manual clips on layers above the synced video: timing, in/out, speed, position/size, flip, reverse, invert, hue, opacity. **Beat-cut generator**: cuts a video on every onset of the mix (sequential / random / restart). |
| ☁ | **Cloud & Sharing** | Sign up / sign in, storage quota, move the local library to the cloud, per-file visibility (private / unlisted / public), share a project with collaborators (editor / viewer) with conflict detection, create and browse source packs, “save to my library”, report items. Admins get a moderation queue (take down / restore / dismiss). |

## Architecture

```
src/core/          UI-agnostic engine — pure TS, unit-tested in Node
  types.ts           JSON-serialisable project model (tracks, samples, effects, clips)
  audio/pcm.ts       planar PCM container + DSP helpers (slice, resample, mix, fade…)
  audio/wav.ts       WAV encode/decode
  audio/decode.ts    browser: probe + decode any media (Web Audio → Mediabunny fallback)
  analysis/pitch.ts  YIN f0 tracking, root detection, contour → notes
  analysis/onset.ts  spectral-flux onsets, tempo estimation, slicing
  analysis/pianoRoll.ts  piano-roll video → notes (streaming scanner, grid/colour calibration)
  analysis/align.ts  notes ↔ audio: pitch/octave alignment, chroma agreement, pitch accuracy
  analysis/sampleFinder.ts  ranked pitched syllables (steady vowel + onset)
  midi/midi.ts       .mid I/O + editing ops (quantize, legato, voices…)
  midi/transcribe.ts Basic Pitch (lazy-loaded TF.js) / YIN transcription
  render/sampler.ts  Sound Applier: sample-accurate note rendering
  render/effects.ts  pure-JS effect DSP + parameter specs (UI is generated from them)
  render/mix.ts      project mixdown, auto-level
  render/psola.ts    TD-PSOLA: flatten pitch, formant-preserving shift
  render/loudness.ts BS.1770 loudness, true peak, limiter, normalisation
  video/timeline.ts  notes → VideoEvents (shares playbackRate() with the sampler ⇒ A/V lock), scenes
  video/frameStream.ts  RGBA frame access for analysis (WebCodecs)
  video/frames.ts    WebCodecs frame cache (batched sorted decode → ImageBitmap LRU)
  video/compositor.ts draws one frame (layout, flip, hue, punch, flash)
  video/export.ts    offline, frame-exact encode via Mediabunny (MP4/WebM)
  storage/           MediaStore / ProjectStore interfaces; IndexedDB + remote (server) implementations
src/ui/            React UI (one panel per tool) — deliberately plain for now
server/            API server: auth, uploads, projects, packs, moderation (+ app.test.ts)
tests/             vitest unit tests + Playwright e2e (tests/e2e)
```

Key design choice: **one timing function for sound and picture.** `playbackRate()`
(`2^((pitch − root)/12)` in resample mode, 1 in natural/fixed mode) decides how
fast the sample plays; the video timeline uses the same function to decide which
source frame to show. The e2e test
verifies this with a colour-coded video: the exported frame at every probed
time matches the frame the pitched audio is playing.

### Server (`server/`)

Hono on Node, SQLite (`node:sqlite`), files on disk (`DATA_DIR/blobs`). No native
dependencies. `MediaStore` / `ProjectStore` in the client have local (IndexedDB)
and remote implementations (`src/core/storage/remote.ts`); the rest of the app
does not know which one is active.

| Area | Behaviour |
|------|-----------|
| Accounts | email + password (scrypt), bearer session tokens, rate-limited auth, sign-up requires accepting the content & copyright policy (`server/policy.ts` — edit it before going live) |
| Uploads | streamed to disk with size + quota limits, **magic-byte validation** (only real audio/video containers), SHA-256 dedupe, HTTP Range streaming |
| Visibility | `private` (default) · `unlisted` (anyone with the ID) · `public` (listed via packs). Private media is also readable by collaborators of a project that uses it |
| Projects | versioned; a save based on a stale version returns **409** and the UI offers “load their version” / “overwrite with mine”; roles owner / editor / viewer |
| Source packs | named collections of your uploads; making a pack shared makes its items unlisted; others can save items to their library |
| Moderation | anyone (even signed-out, with a contact email) can report media or packs; admins (`ADMIN_EMAILS`) take down (HTTP 451), restore after a counter-notice, dismiss, or suspend users. Every action is written to an audit log |

Configuration (environment variables): `PORT` (8787), `DATA_DIR` (./data),
`CORS_ORIGINS` (comma-separated browser origins), `MAX_UPLOAD_MB` (500),
`USER_QUOTA_MB` (2048), `ADMIN_EMAILS`, `ALLOW_SIGNUP` (true),
`COPYRIGHT_CONTACT`, `SESSION_DAYS` (30), `STATIC_DIR` (serve the built frontend).

> Hosting other people's uploads makes you an intermediary: publish a real
> takedown contact, act on notices promptly, and check the rules where you
> operate (DMCA in the US, the DSA in the EU, etc.). The moderation tools are
> there to make that workable, not to replace legal advice.

## Deployment

**Frontend on GitHub Pages** — `.github/workflows/pages.yml` builds and publishes
`dist/`. One-time: *Settings → Pages → Build and deployment → Source: GitHub
Actions*. (Serving the repository root directly shows only the raw source.) To
point the hosted site at your server by default, set the repository variable
`OTO_API_URL`; users can also type a server URL in ☁ Cloud & Sharing.

**Server (any VPS / container host)**

```bash
docker compose up -d          # API + frontend on :8787, data in the oto-data volume
```

or without Docker: `npm ci && npm run build && npm start`. Put HTTPS in front
(e.g. Caddy: `api.example.com { reverse_proxy localhost:8787 }`) — an HTTPS site
such as GitHub Pages cannot call a plain-HTTP API. Add the site's origin to
`CORS_ORIGINS`. Back up `DATA_DIR` (database + files).

## Browser support

Needs WebCodecs (Chrome/Edge 94+, Safari 16.4+, Firefox 130+). MP4 export uses
H.264 + AAC where the browser can encode them (Chrome, Edge, Safari); otherwise
it falls back to Opus-in-MP4 or WebM.

## Roadmap

- Move heavy DSP / transcription into Web Workers (UI stays responsive on long songs)
- Source separation (vocals/drums/bass) before MIDI extraction
- Time-stretch (WSOLA) for samples
- Pitch-bend / vibrato from Basic Pitch contours; per-note sample choice (multi-sample instruments)
- Video: per-note crop/zoom keyframes, chroma key, more layouts, motion-tracked pan
- Multi-track timeline editor with drag & drop; undo/redo
- Project import/export as a single `.otoeum` bundle
- Cloud: S3/R2 storage driver, email verification & password reset, real-time co-editing, resumable uploads
- i18n (日本語 / 한국어 / Polski / Українська)

## Licences

App code: no licence chosen yet (add a LICENSE before publishing). Bundled model: Spotify Basic Pitch (Apache-2.0),
copied from `@spotify/basic-pitch` at build time.
