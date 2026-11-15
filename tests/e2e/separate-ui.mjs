// Manual e2e: Demucs separation through the UI (model not in the repo):
//   node tests/e2e/separate-ui.mjs <htdemucs.onnx> <source video> [screenshot dir]
import { createServer } from 'vite';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [modelPath, video, shots] = process.argv.slice(2);
// BASE=http://host:port to test an already-running (e.g. production) build instead of the dev server
const BASE = process.env.BASE ?? 'http://localhost:5231';
const server = process.env.BASE ? null : await createServer({ server: { port: 5231 }, logLevel: 'error' });
await server?.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
if (process.env.DEBUG) {
  page.on('console', (m) => console.log('[console]', m.text().slice(0, 300)));
  page.on('requestfailed', (r) => console.log('[failed]', r.url().slice(0, 160), r.failure()?.errorText));
  page.on('response', (r) => r.status() >= 400 && console.log('[http]', r.status(), r.url().slice(0, 160)));
  page.on('worker', (w) => console.log('[worker]', w.url().slice(0, 160)));
}
const idle = (ms = Number(process.env.IDLE_MS ?? 1800000)) => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: ms });
try {
  await page.goto(BASE + '/');
  console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated), 'cores:', await page.evaluate(() => navigator.hardwareConcurrency));
  await page.locator('input[type=file]').setInputFiles([video]);
  await page.waitForFunction(() => document.querySelectorAll('.list tbody tr').length === 1, null, { timeout: 30000 });
  await idle();
  await page.getByRole('button', { name: /Sound Editor/ }).click();
  await idle();
  await page.locator('.section:has(h3:text-matches("^Separate voice")) select').first().selectOption('neural');
  await page.locator('.section:has(h3:text-matches("^Separate voice")) input[type=file]').setInputFiles(modelPath);
  await page.waitForSelector('text=/Model: /', { timeout: 120000 });
  const t0 = Date.now();
  await page.getByRole('button', { name: /^Separate / }).click();
  await idle();
  if (await page.locator('.error').count()) throw new Error(await page.locator('.error').first().innerText());
  console.log(`UI separation took ${((Date.now() - t0) / 1000).toFixed(0)} s:`, await page.locator('text=/Demucs \\(/').first().innerText());
  console.log(await page.locator('text=/Stems: /').first().innerText());
  if (shots) await page.screenshot({ path: `${shots}/separate-ui.png` });
} catch (e) {
  errors.push(String(e));
} finally {
  await browser.close();
  await server?.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'OK');
process.exit(errors.length ? 1 : 0);
