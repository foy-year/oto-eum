# 音MAD recipe (CLI)

End-to-end example of making a 音MAD with the oto-eum core, outside the UI:

1. `read_roll.ts <workdir> [C5-pitch]` — reads a piano-roll "MIDI video" (raw RGB frames in
   `<workdir>/bf/b.rgb`, e.g. `ffmpeg -i midi.mp4 -vf fps=30 -pix_fmt rgb24 -f rawvideo b.rgb`)
   with `src/core/analysis/pianoRoll.ts` → `roll.json` / `roll.mid`. The screen calibration
   (note area, pitch row, track hues) in the script is for a 640×360 Domino recording.
2. `build_project.ts <workdir>` — quantizes the notes, cuts samples (sound + picture) from the
   other video, adds drums from its transients, auto-levels stems, mixes, and runs pitch/chroma
   self-checks → `project.json`, `mix.wav`.
3. `render.mjs <workdir> <source-video> <out.mp4>` — renders the synced video in Chromium with the
   toolkit's WebCodecs exporter (scene layouts are defined in `render.ts`).

Source media and renders are not committed (`out/` is git-ignored).
