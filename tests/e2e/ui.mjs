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
  await shot('2-sound-editor');
  // 3 MIDI extractor: mono on the melody
  await tab('MIDI Extractor');
  await page.locator('.section').nth(1).locator('select').first().selectOption({ label: 'melody.mp3' });
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
  await page.getByRole('button', { name: /Render & play/ }).click();
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
const real = errors.filter((e) => !/AudioContext was not allowed|play\(\) failed/.test(e));
console.log(real.length ? 'ERRORS:\n' + real.join('\n') : 'UI smoke test passed');
process.exit(real.length ? 1 : 0);
