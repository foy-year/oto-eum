// Manual e2e for the piano-roll reader UI on a real MIDI video:
//   node tests/e2e/roll-ui.mjs <midi-video.mp4> <roi x0,y0,x1,y1 in video px @640w> [screenshot dir]
import { createServer } from 'vite';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [video, roiArg, shots] = process.argv.slice(2);
const [x0, y0, x1, y1] = roiArg.split(',').map(Number);
const server = await createServer({ server: { port: 5211 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const idle = () => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 300000 });
try {
  await page.goto('http://localhost:5211/');
  await page.locator('input[type=file]').setInputFiles([video]);
  await page.waitForFunction(() => document.querySelectorAll('.list tbody tr').length === 1, null, { timeout: 30000 });
  await idle();
  await page.getByRole('button', { name: /MIDI Extractor/ }).click();
  await idle();
  const c = page.locator('canvas.roll-canvas');
  await page.waitForFunction(() => document.querySelector('canvas.roll-canvas')?.width === 640, null, { timeout: 60000 });
  const box = await c.boundingBox();
  const W = await c.evaluate((el) => el.width);
  const s = box.width / W;
  await page.mouse.move(box.x + x0 * s, box.y + y0 * s);
  await page.mouse.down();
  await page.mouse.move(box.x + x1 * s, box.y + y1 * s, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: /Auto-detect/ }).click();
  await idle();
  console.log('auto:', await page.locator('.notice').first().innerText());
  const rows = await page.locator('.swatch').count();
  console.log('colours:', rows);
  if (shots) await c.screenshot({ path: `${shots}/roll-calibration.png` });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Read MIDI from video' }).click();
  await idle();
  if (await page.locator('.error').count()) console.log('ERROR BANNER:', await page.locator('.error').first().innerText());
  console.log(`read in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, await page.locator('.notice').first().innerText());
  await page.getByRole('button', { name: /MIDI Editor/ }).click();
  const opts = await page.locator('select').filter({ hasText: '(' }).first().locator('option').allInnerTexts();
  console.log('tracks:', opts.join(' | '));
  if (shots) await page.screenshot({ path: `${shots}/roll-midi-editor.png` });
  if (shots) {
    const tracks = await page.evaluate(() => globalThis.__otoStore.getState().project.tracks);
    (await import('node:fs')).writeFileSync(`${shots}/ui-tracks.json`, JSON.stringify(tracks));
  }
} catch (e) {
  errors.push(String(e));
} finally {
  await browser.close();
  await server.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'OK');
process.exit(errors.length ? 1 : 0);
