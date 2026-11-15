// node scripts/otomad/render.mjs <workdir> <source-video> <out.mp4>
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [W, SRC, OUT] = process.argv.slice(2);
const server = await createServer({ server: { port: 5207 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('[browser]', m.text()));
await page.route('**/otomad/project.json', (r) => r.fulfill({ body: readFileSync(`${W}/project.json`), contentType: 'application/json' }));
await page.route('**/otomad/source.mp4', (r) => r.fulfill({ body: readFileSync(SRC), contentType: 'video/mp4' }));
await page.route('**/otomad/mix.wav', (r) => r.fulfill({ body: readFileSync(`${W}/mix.wav`), contentType: 'audio/wav' }));
await page.route('**/otomad/upload', (r) => {
  writeFileSync(OUT, r.request().postDataBuffer());
  r.fulfill({ status: 200, body: 'ok' });
});
try {
  await page.goto('http://localhost:5207/scripts/otomad/render.html');
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60000 });
  const res = await page.evaluate(() => window.renderOtomad());
  console.log('rendered', res, '→', OUT);
} finally {
  await browser.close();
  await server.close();
}
