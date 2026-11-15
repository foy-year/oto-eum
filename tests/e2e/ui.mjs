// UI smoke test: drives every module tab like a user. Usage: node tests/e2e/ui.mjs [screenshotDir]
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.argv[2];
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('requestfailed', (r) => errors.push('request failed: ' + r.url().slice(0, 120)));
page.on('dialog', (d) => d.accept());
const tab = (name) => page.getByRole('button', { name: new RegExp(name) }).first().click();
const idle = () => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 120000 });
const shot = async (n) => shots && page.screenshot({ path: `${shots}/${n}.png` });
const banner = async () => (await page.locator('.error').count()) && errors.push('UI error: ' + (await page.locator('.error').first().innerText()));
try {
  await page.goto('http://localhost:5198/');
  // 1 Library: upload
  await page.locator('input[type=file]').setInputFiles([resolve('tests/fixtures/colors.mp4'), resolve('tests/fixtures/melody.mp3')]);
  await page.waitForFunction(() => document.querySelectorAll('.list tbody tr').length === 2, null, { timeout: 30000 });
  await idle();
  await shot('1-library');
  // 2 Sound editor on the video: select whole range by dragging, create sample
  await page.locator('.list tbody tr').first().getByRole('button', { name: 'Edit sound' }).click();
  await idle();
  const wf = page.locator('canvas.waveform');
  const box = await wf.boundingBox();
  await page.mouse.move(box.x + 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Create sample from selection/ }).click();
  await page.waitForSelector('text=Sample: ');
  // #3 tuning controls on the new sample
  await page.locator('label:has-text("Pitch mode") select').selectOption('natural');
  await page.locator('label:has-text("Flatten pitch") select').selectOption('1');
  await page.waitForSelector('text=green: flattened');
  // #2 sample finder
  await page.getByRole('button', { name: 'Find pitched syllables' }).click();
  await idle();
  const cands = await page.locator('.cand').count();
  console.log('sample finder candidates:', cands);
  if (!cands) throw new Error('sample finder found nothing');
  await page.locator('.cand').first().getByRole('button', { name: '+ loop' }).click();
  // #12 built-in voice separation → stems linked to the video → samples take their sound from the vocals
  await page.getByRole('button', { name: /^Separate colors/ }).click();
  await idle();
  await page.waitForSelector('text=/Stems: vocals, accompaniment/');
  await page.getByRole('button', { name: /Use vocals for this source/ }).click();
  console.log('separation:', await page.locator('text=/Built-in separation done/').first().innerText());
  const iso = await page.evaluate(() => crossOriginIsolated);
  console.log('crossOriginIsolated:', iso);
  await shot('2-sound-editor');
  // 3 MIDI extractor: mono on the melody
  await tab('MIDI Extractor');
  await page.locator('.section', { hasText: 'Extract MIDI from audio / video' }).locator('select').first().selectOption({ label: 'melody.mp3' });
  await idle();
  await page.locator('select').filter({ hasText: 'Polyphonic' }).selectOption('mono');
  await page.getByRole('button', { name: 'Extract MIDI' }).click();
  await page.waitForSelector('text=/Extracted \\d+ notes/', { timeout: 60000 });
  await shot('3-extract');
  // 4 MIDI editor: quantize + draw a note
  await tab('MIDI Editor');
  await page.getByRole('button', { name: 'Quantize', exact: true }).click();
  const roll = await page.locator('canvas.pianoroll').boundingBox();
  await page.mouse.click(roll.x + 400, roll.y + 200);
  await shot('4-midi-editor');
  // 5 Sound applier: assign sample, render
  await tab('Sound Applier');
  await page.locator('.list tbody tr').first().locator('select').selectOption({ index: 1 });
  // #5 auto-level + master loudness + M4A
  await page.getByRole('button', { name: 'Auto-level tracks' }).click();
  await idle();
  await page.locator('label:has-text("Master loudness") select').selectOption('-14');
  // #11 the render runs in the DSP worker: the page keeps animating meanwhile
  await page.evaluate(() => {
    const g = globalThis;
    g.__frames = 0;
    g.__t0 = performance.now();
    const tick = () => {
      g.__frames++;
      if (document.querySelector('.busy') || performance.now() - g.__t0 < 300) requestAnimationFrame(tick);
      else g.__t1 = performance.now();
    };
    requestAnimationFrame(tick);
  });
  await page.getByRole('button', { name: /Render & play/ }).click();
  await idle();
  const resp = await page.evaluate(() => ({ mode: globalThis.__otoDspMode, fps: (globalThis.__frames * 1000) / ((globalThis.__t1 ?? performance.now()) - globalThis.__t0) }));
  console.log(`dsp mode: ${resp.mode}, UI frame rate during render: ${resp.fps.toFixed(0)} fps`);
  if (resp.mode !== 'worker') throw new Error('DSP did not run in the worker');
  const mixLabel = await page.locator('.hint', { hasText: /^Mix: / }).first().innerText();
  console.log('mix:', mixLabel);
  const m = /(-?[\d.−-]+) LUFS/.exec(mixLabel.replace('−', '-'));
  if (!m || Math.abs(parseFloat(m[1]) + 14) > 0.6) throw new Error('master loudness not at -14 LUFS: ' + mixLabel);
  const dlA = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Export M4A' }).click();
  await dlA;
  await idle();
  console.log('audio export:', await page.locator('text=/Exported (M4A|WEBM)/').first().innerText());
  await idle();
  await shot('5-applier');
  // 6 Effects: add preset on master, preview
  await tab('Sound Effector');
  await page.locator('select').filter({ hasText: 'Presets' }).selectOption('Lo-fi / 8-bit');
  await page.getByRole('button', { name: /Preview with effects/ }).click();
  await idle();
  await shot('6-effects');
  // 7 Video sync: preview + export
  await tab('Video Synchronizer');
  // #4 scenes
  await page.getByRole('button', { name: /\+ Scene at/ }).click();
  await page.locator('.section:has(h3:text-matches("^Scenes"))').locator('select').first().selectOption('focus');
  await page.waitForSelector('.scene-preview');
  await page.locator('select').filter({ hasText: '1280x720' }).selectOption('640x360');
  await page.getByRole('button', { name: '▶ Play' }).click();
  await idle();
  await page.waitForTimeout(800);
  await shot('7-sync');
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: /Export video/ }).click();
  const file = await dl;
  console.log('downloaded', file.suggestedFilename());
  // 8 Video editor: beat cut
  await tab('Video Editor');
  await page.getByRole('button', { name: 'Generate cuts' }).click();
  await idle();
  // video FX timeline + "YOUKAI ZONE" title-burst preset (prompt → default word)
  await page.locator('select').filter({ hasText: '+ Effect at' }).selectOption('kaleido');
  await page.getByRole('button', { name: '+ Title burst' }).click();
  await page.waitForSelector('text=/Video FX \\(4\\)/');
  await page.waitForSelector('text=/Text & titles \\(2\\)/');
  console.log('video fx + title burst added');
  const clips = await page.locator('.strip-ev.clip').count();
  console.log('beat-cut clips', clips);
  await shot('8-video-editor');
  await banner();
} catch (e) {
  errors.push(String(e));
  await shot('failure');
} finally {
  await browser.close();
  await server.close();
}
// aborted loads of revoked preview blobs (element unmounted) are harmless
const real = errors.filter((e) => !/AudioContext was not allowed|play\(\) failed|request failed: blob:|ERR_FILE_NOT_FOUND/.test(e));
console.log(real.length ? 'ERRORS:\n' + real.join('\n') : 'UI smoke test passed');
process.exit(real.length ? 1 : 0);
