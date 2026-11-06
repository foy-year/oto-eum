// End-to-end check of the browser pipeline in real Chromium (Playwright).
// Usage: npm run test:e2e
import { createServer } from 'vite';
import { createRequire } from 'node:module';

// Resolve Playwright from the project or a global install (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const near = (rgb, target, tol = 60) => rgb.every((v, i) => Math.abs(v - target[i]) <= tol);
const COLORS = { red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255] };
const EXPECT = ['red', 'lime', 'blue', 'white', 'red', 'lime'];

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[browser]', m.text()));
let failed = 0;
const check = (name, ok, info) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`, info === undefined ? '' : JSON.stringify(info));
  if (!ok) failed++;
};
try {
  await page.goto('http://localhost:5199/tests/e2e/harness.html');
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60000 });
  const codecs = await page.evaluate(() => window.oto.codecs());
  console.log('codecs', codecs);

  for (const f of ['melody.mp3', 'colors.webm', 'colors.mp4']) {
    try {
      const p = await page.evaluate((n) => window.oto.probe(n), f);
      check(`probe ${f}`, p.duration > 1, p);
      const d = await page.evaluate((n) => window.oto.decode(n), f);
      check(`decode audio of ${f}`, d.duration > 1 && (f === 'melody.mp3' || Math.abs(d.rootMidi - 60) < 0.5), d);
    } catch (e) {
      check(`probe/decode ${f}`, false, String(e).slice(0, 200));
    }
  }

  const mono = await page.evaluate(() => window.oto.transcribe('melody.mp3', 'mono'));
  check('MIDI extraction (mono/YIN) melody C4 E4 G4 C5', JSON.stringify(mono.notes.map((n) => n.pitch)) === '[60,64,67,72]', mono);
  const poly = await page.evaluate(() => window.oto.transcribe('chord.mp3', 'poly'));
  const pitches = [...new Set(poly.notes.map((n) => n.pitch))].sort();
  check('MIDI extraction (poly/Basic Pitch) C major chord', [60, 64, 67].every((p) => pitches.includes(p)), { ms: Math.round(poly.ms), pitches });

  for (const [file, prefer] of [['colors.webm', 'webm'], ['colors.mp4', 'mp4']]) {
    try {
      const r = await page.evaluate(([f, p]) => window.oto.pipeline(f, p), [file, prefer]);
      check(`export ${file} → ${r.extension} (${r.videoCodec}/${r.audioCodec}) in ${Math.round(r.ms)} ms`, r.outHasAudio && Math.abs(r.outDuration - 3.5) < 0.15, { duration: r.outDuration, size: r.size });
      check('  audio pitched an octave up on note 1', Math.abs(r.outAudioPitchFirstNote - 72) < 0.6, r.outAudioPitchFirstNote);
      r.pixels.forEach((p, i) => check(`  frame @${p.t}s shows ${EXPECT[i]} (video locked to note rate)`, near(p.rgb, COLORS[EXPECT[i]]), p.rgb));
    } catch (e) {
      check(`pipeline ${file}`, false, String(e).slice(0, 300));
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll e2e checks passed');
process.exit(failed ? 1 : 0);
