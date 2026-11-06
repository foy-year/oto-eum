// Cloud e2e: real server process (API + built frontend, one origin) driven by Chromium.
// Usage: npm run build && node tests/e2e/cloud.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 8799;
const URL = `http://localhost:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'oto-cloud-'));
const srv = spawn(process.execPath, ['server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: data, STATIC_DIR: 'dist', ADMIN_EMAILS: 'admin@test.io', NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok, bad) => {
  srv.stdout.on('data', (d) => String(d).includes('oto-eum server') && ok());
  srv.on('exit', (c) => bad(new Error('server exited ' + c)));
  setTimeout(() => bad(new Error('server start timeout')), 15000);
});

let failed = 0;
const check = (name, ok, info) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`, info === undefined ? '' : JSON.stringify(info));
  if (!ok) failed++;
};
const browser = await chromium.launch();
const errors = [];
async function user(email, name) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await page.getByRole('button', { name: /Local/ }).click();
  await page.getByRole('button', { name: 'Need an account?' }).click();
  await page.locator('input[type=email]').fill(email);
  await page.locator('label:has-text("Display name") input').fill(name);
  await page.locator('input[type=password]').fill('correct horse battery');
  await page.getByText('I accept the content').click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForSelector(`text=Signed in to`);
  return page;
}
const idle = (page) => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 60000 });
const tab = (page, n) => page.getByRole('button', { name: new RegExp(n) }).first().click();

try {
  const alice = await user('alice@test.io', 'Alice');
  check('register + sign in through the UI', await alice.locator('text=as Alice').count() > 0);

  // upload a video to the cloud
  await tab(alice, 'Library');
  await alice.locator('input[type=file]').setInputFiles([resolve('tests/fixtures/colors.mp4')]);
  await alice.waitForFunction(() => document.querySelectorAll('.list tbody tr').length === 1, null, { timeout: 30000 });
  check('upload goes to the server', (await alice.locator('text=/uploaded to http/').count()) > 0);

  // make a sample + track so the project references the media
  await alice.locator('.list tbody tr').first().getByRole('button', { name: 'Edit sound' }).click();
  await idle(alice);
  const wf = await alice.locator('canvas.waveform').boundingBox();
  await alice.mouse.move(wf.x + 5, wf.y + 40);
  await alice.mouse.down();
  await alice.mouse.move(wf.x + wf.width / 2, wf.y + 40, { steps: 4 });
  await alice.mouse.up();
  await alice.getByRole('button', { name: /Create sample from selection/ }).click();
  await alice.locator('.top .pname').fill('Shared song');
  await alice.waitForTimeout(2500); // autosave

  // create a public pack containing the upload
  await tab(alice, 'Cloud');
  await alice.locator('label:has-text("Name") input').first().fill('Colour pack');
  await alice.getByRole('button', { name: '+ Create pack' }).click();
  await idle(alice);
  await alice.locator('select').filter({ hasText: 'Add to pack' }).first().selectOption({ label: 'Colour pack' });
  await idle(alice);
  await alice.locator('tr:has-text("items"):has-text("Colour pack") select').selectOption('public');
  await idle(alice);

  // second user: browse pack, save item, and get the project shared
  const bob = await user('bob@test.io', 'Bob');
  await bob.getByRole('button', { name: 'Search', exact: true }).click();
  await idle(bob);
  check('public pack is listed for other users', (await bob.locator('text=Colour pack').count()) > 0);
  await bob.locator('tr:has-text("Colour pack")').getByRole('button', { name: 'Open' }).click();
  await idle(bob);
  await bob.getByRole('button', { name: 'Save to my library' }).click();
  await idle(bob);
  await tab(bob, 'Library');
  check('saved pack item appears in Bob’s library', (await bob.locator('text=from Alice').count()) > 0);

  await tab(alice, 'Cloud');
  await alice.locator('label:has-text("Share with") input').fill('bob@test.io');
  await alice.getByRole('button', { name: 'Share', exact: true }).click();
  await idle(alice);
  check('project shared with Bob', (await alice.locator('td:has-text("bob@test.io")').count()) > 0);

  // Bob opens the shared project and edits it
  await bob.locator('select').filter({ hasText: 'Open project' }).focus();
  await bob.waitForTimeout(500);
  const opt = await bob.locator('select:has(option:text-matches("Shared song")) option:text-matches("Shared song")').getAttribute('value');
  await bob.locator('select').filter({ hasText: 'Open project' }).selectOption(opt);
  await bob.waitForFunction(() => document.querySelector('.pname')?.value === 'Shared song', null, { timeout: 10000 });
  check('Bob opens Alice’s shared project', true);
  await tab(bob, 'Sound Editor');
  await idle(bob);
  check('Bob can load Alice’s private media via the shared project', (await bob.locator('canvas.waveform').count()) > 0 && (await bob.locator('.error').count()) === 0);
  await bob.locator('.top .pname').fill('Shared song (Bob edit)');
  await bob.waitForTimeout(2500);

  // Alice, who still has the old version, edits → conflict
  await alice.locator('.top .pname').fill('Shared song (Alice edit)');
  await alice.waitForSelector('text=/changed by someone else/', { timeout: 10000 });
  check('concurrent edit is detected as a conflict', true, await alice.locator('.error').first().innerText());
  await alice.getByRole('button', { name: 'Load their version' }).click();
  await alice.waitForFunction(() => document.querySelector('.pname')?.value === 'Shared song (Bob edit)', null, { timeout: 10000 });
  check('“Load their version” pulls Bob’s edit', true);

  // reload keeps the session
  await bob.reload();
  await bob.waitForSelector('text=☁ Bob', { timeout: 15000 });
  check('session survives a page reload', true);
} catch (e) {
  check('cloud flow', false, String(e).slice(0, 400));
} finally {
  await browser.close();
  srv.kill();
  rmSync(data, { recursive: true, force: true });
}
if (errors.length) check('no page errors', false, errors);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll cloud e2e checks passed');
process.exit(failed ? 1 : 0);
