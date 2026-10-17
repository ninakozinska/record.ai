// End-to-end check in real Chromium: two devices (desktop + phone) share notes
// live, photos/camera work, and edits made offline sync when back online.
// Claude is replaced by a fake client so this runs without an API key.
// Usage: npm run e2e   (screenshots land in data-e2e/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { createApp } from '../server/app.js';
import { Organizer } from '../server/organizer.js';

const out = path.resolve('data-e2e');
fs.mkdirSync(out, { recursive: true });

const fake = {
  beta: {
    messages: {
      parse: async (p) => {
        const text = p.messages[0].content.at(-1).text;
        const note = text.match(/<note[^>]*>\n([\s\S]*?)\n<\/note>/)[1];
        const urgent = /tomorrow|today/i.test(note);
        const shopping = /milk|eggs|buy/i.test(note);
        await new Promise((r) => setTimeout(r, 200));
        return {
          stop_reason: 'end_turn',
          parsed_output: {
            title: note.includes('photo only') ? 'Whiteboard photo' : note.split(/[.\n]/)[0].slice(0, 40),
            summary: 'Summary of: ' + note.slice(0, 60),
            group: shopping ? 'Shopping' : urgent ? 'Work' : 'Ideas',
            priority: urgent ? 'urgent' : shopping ? 'high' : 'low',
            priority_reason: urgent ? 'deadline tomorrow' : 'no rush',
            tags: shopping ? ['groceries'] : [],
            due_date: urgent ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : null,
          },
        };
      },
    },
  },
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-e2e-'));
const { app, store } = createApp({
  dataDir,
  organizer: (args) => new Organizer({ ...args, client: fake }),
});
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
};

const pages = {};
try {
  const desktopCtx = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['camera'] });
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['camera'] });
  const desktop = (pages.desktop = await desktopCtx.newPage());
  const phone = (pages.phone = await phoneCtx.newPage());
  watch(desktop, 'desktop');
  watch(phone, 'phone');
  await desktop.goto(url);
  // First visit: create the owner account.
  await desktop.waitForSelector('#login[open] #loginTitle:text("Create your account")');
  await desktop.fill('#loginName', 'Nina');
  await desktop.fill('#loginEmail', 'nina@example.com');
  await desktop.fill('#loginPassword', 'short');
  await desktop.click('#loginSubmit');
  await desktop.waitForSelector('#loginError:text("at least 8")');
  await desktop.fill('#loginPassword', 'correct horse');
  await desktop.click('#loginSubmit');
  await desktop.waitForSelector('.sync-dot.ok');
  await desktop.waitForSelector('#accountBtn:text("N")');
  // Phone: log in to the same account (wrong password first).
  await phone.goto(url);
  await phone.waitForSelector('#login[open] #loginTitle:text("Log in")');
  await phone.fill('#loginEmail', 'nina@example.com');
  await phone.fill('#loginPassword', 'wrong password');
  await phone.click('#loginSubmit');
  await phone.waitForSelector('#loginError:text("Wrong email or password")');
  await phone.fill('#loginPassword', 'correct horse');
  await phone.click('#loginSubmit');
  await phone.waitForSelector('.sync-dot.ok');
  console.log('✓ sign up on desktop, log in on phone');

  // 1. Type a note on desktop -> organized by AI -> appears on phone.
  await desktop.fill('#composer textarea', 'Send the quarterly report tomorrow morning');
  await desktop.keyboard.press('Control+Enter');
  await phone.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
  await phone.waitForSelector('.group.p-urgent .note');
  console.log('✓ desktop note organized and synced to phone');

  // 2. Phone adds a note with a picked image.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await phone.fill('#composer textarea', 'Buy milk and eggs');
  await phone.setInputFiles('#composer [data-role=file]', { name: 'a.png', mimeType: 'image/png', buffer: png });
  await phone.waitForSelector('#composer .thumb img');
  await phone.click('#composer [data-role=save]');
  await desktop.waitForSelector('.note h3:text("Buy milk and eggs")');
  await desktop.waitForSelector('.note:has(h3:text("Buy milk and eggs")) .note-images img[src*="images/"]');
  console.log('✓ phone note with image synced to desktop');

  // 3. Camera capture (fake device) on desktop, photo-only note.
  await desktop.click('#composer [data-role=camera]');
  await desktop.waitForFunction(() => document.querySelector('#cameraVideo').videoWidth > 0);
  await desktop.click('#cameraShoot');
  await desktop.waitForSelector('#cameraCount:text("1 photo added")');
  await desktop.click('#cameraClose');
  await desktop.waitForSelector('#composer .thumb img');
  await desktop.click('#composer [data-role=save]');
  await phone.waitForSelector('.note h3:text("Whiteboard photo")');
  console.log('✓ camera photo note synced');

  // 4. Offline edit on phone queues and syncs later.
  await phoneCtx.setOffline(true);
  await phone.waitForSelector('.sync-dot.offline', { timeout: 15000 });
  await phone.fill('#composer textarea', 'Idea: a podcast about gardening');
  await phone.click('#composer [data-role=save]');
  await phone.waitForSelector('.note h3:text("Idea: a podcast about gardening")');
  await phoneCtx.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('online')));
  await desktop.waitForSelector('.note h3:text("Idea: a podcast about gardening")', { timeout: 15000 });
  console.log('✓ offline note synced after reconnect');

  // 5. Groups view + override in editor + done.
  await desktop.click('.view-toggle [data-view=groups]');
  await desktop.waitForSelector('.group h2:text("Shopping")');
  await desktop.click('.note h3:text("Idea: a podcast")');
  await desktop.fill('#editorGroup', 'Hobbies');
  await desktop.selectOption('#editorPriority', 'high');
  await desktop.click('#editorSave');
  await phone.waitForSelector('.note:has(h3:text("Idea: a podcast")) .badge:text("High")');
  await desktop.waitForSelector('.group h2:text("Hobbies")');
  await phone.click('.note:has(h3:text("Buy milk")) [data-check]');
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (1)")');
  console.log('✓ overrides and done state synced');

  // Every note finishes AI processing on both devices.
  for (const p of [desktop, phone]) {
    await p.waitForFunction(() => !document.querySelector('.ai-pending'), null, { timeout: 5000 }).catch(async (e) => {
      console.log(await p.evaluate(() => [...document.querySelectorAll('.note:has(.ai-pending) h3')].map((h) => h.textContent)));
      console.log(JSON.stringify(store.changesSince(0).map((n) => [n.text, n.ai_status, n.edited_at])));
      throw e;
    });
  }
  await desktop.screenshot({ path: path.join(out, 'desktop-groups.png'), fullPage: true });
  await desktop.click('.view-toggle [data-view=priority]');
  await desktop.screenshot({ path: path.join(out, 'desktop-priority.png'), fullPage: true });
  await phone.screenshot({ path: path.join(out, 'phone.png'), fullPage: true });
  await phone.click('.note h3:text("Send the quarterly")');
  await phone.waitForSelector('#editor[open]');
  await phone.screenshot({ path: path.join(out, 'phone-editor.png') });

  // Reload works from local cache.
  await phone.reload();
  await phone.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');

  // Account menu shows the address for the iPhone app; log out clears the phone.
  await phone.click('#accountBtn');
  await phone.waitForSelector('#account[open] #accountEmail:text("nina@example.com")');
  await phone.waitForSelector('#appAddress code');
  await phone.screenshot({ path: path.join(out, 'phone-account.png') });
  await phone.click('#logoutBtn');
  await phone.waitForSelector('#login[open]');
  assert.equal(await phone.locator('.note').count(), 0, 'notes removed from the device after log out');
  await desktop.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
  console.log('✓ account menu and log out');

  assert.deepEqual(errors, []);
  console.log('All e2e checks passed. Screenshots in', out);
} catch (err) {
  // Keep evidence of what each device showed when something failed.
  for (const [name, page] of Object.entries(pages)) {
    await page.screenshot({ path: path.join(out, `FAILED-${name}.png`), fullPage: true }).catch(() => {});
  }
  console.error('Browser errors seen:', errors);
  throw err;
} finally {
  await browser.close();
  server.close();
}
