// Manual e2e for neural separation (model not in the repo):
//   node tests/e2e/separate.mjs <htdemucs.onnx> <source media> [seconds]
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [modelPath, srcPath, secs = '9'] = process.argv.slice(2);
const server = await createServer({ server: { port: 5221 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ dumpio: !!process.env.DUMPIO });
const page = await browser.newPage();
page.on('console', (m) => console.log('[browser]', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
page.on('crash', () => console.log('[crash] page crashed'));
// big model: serve as a static file (git-ignored), not through the DevTools protocol
const { mkdirSync, copyFileSync, existsSync, statSync } = await import('node:fs');
mkdirSync('public/_local', { recursive: true });
if (!existsSync('public/_local/htdemucs.onnx') || statSync('public/_local/htdemucs.onnx').size !== statSync(modelPath).size) copyFileSync(modelPath, 'public/_local/htdemucs.onnx');
await page.route('**/sep/upload', async (r) => {
  if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, r.request().postDataBuffer());
  await r.fulfill({ status: 200, body: 'ok' });
});
await page.route('**/sep/source.mp4', (r) => r.fulfill({ body: readFileSync(srcPath), contentType: 'video/mp4' }));
try {
  await page.goto('http://localhost:5221/tests/e2e/separate-harness.html?' + (process.env.GPU === '0' ? 'gpu=0&' : '') + (process.env.OUT ? 'export=1' : ''));
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 120000 });
  const res = await page.evaluate((s) => window.sep.run(s), Number(secs));
  console.log(JSON.stringify(res, null, 1));
} finally {
  await browser.close();
  await server.close();
}
