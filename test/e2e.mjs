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

// "Continue with Google": Google's servers are faked here and its sign-in
// page is faked in the browser (see step 7).
const fakeGoogle = async (url) => {
  const ok = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (String(url) === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'google-token' });
  return ok({ sub: 'google-nina', email: 'nina@example.com', email_verified: true, name: 'Nina' });
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-e2e-'));
const mails = [];
const { app, store } = createApp({
  dataDir,
  mail: { configured: true, send: async (m) => mails.push(m) },
  organizer: (args) => new Organizer({ ...args, client: fake }),
  oauth: {
    env: { GOOGLE_CLIENT_ID: 'e2e', GOOGLE_CLIENT_SECRET: 'e2e', GITHUB_CLIENT_ID: 'e2e', GITHUB_CLIENT_SECRET: 'e2e' },
    fetch: fakeGoogle,
  },
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
  assert.equal(await phone.isVisible('#loginName'), false, 'no name field when logging in');
  assert.equal(await phone.isVisible('#loginCode'), false, 'no invite code field when logging in');
  await phone.fill('#loginEmail', 'nina@example.com');
  await phone.fill('#loginPassword', 'wrong password');
  // Show lets you check what you typed; Hide covers it again.
  await phone.click('#loginForm [data-pw-toggle]');
  assert.equal(await phone.getAttribute('#loginPassword', 'type'), 'text');
  await phone.screenshot({ path: path.join(out, 'phone-password-shown.png') });
  await phone.click('#loginForm [data-pw-toggle]:text("Hide")');
  assert.equal(await phone.getAttribute('#loginPassword', 'type'), 'password');
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
  // Lists load the small preview, not the full photo.
  await desktop.waitForSelector('.note:has(h3:text("Buy milk and eggs")) .note-images img[src*="images/"][src*="variant=thumb"]');
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
  // A wrong tap? Undo puts it back.
  await phone.click('.toast:has-text("Marked done: Buy milk") .toast-undo');
  await desktop.waitForSelector('[data-toggle-done]', { state: 'detached' });
  await phone.click('.note:has(h3:text("Buy milk")) [data-check]');
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (1)")');
  console.log('✓ overrides and done state synced');

  // 6. "My groups": add Baby with the ＋ chip; it shows with no notes yet and
  //    survives a reload. (Prompts are answered by Playwright.)
  desktop.once('dialog', (d) => d.accept('Baby'));
  await desktop.click('#groupChips [data-add-group]');
  await desktop.waitForSelector('#groupChips [data-group="Baby"]');
  await desktop.reload();
  await desktop.waitForSelector('#groupChips [data-group="Baby"]');
  assert.deepEqual(store.myGroups([...store.db.prepare('SELECT id FROM users').all()][0].id), ['Baby']);
  console.log('✓ my own group added and kept');

  // 7. Lists: "- " lines become items; tick one from the card, add and
  //    reprioritize in the editor; the other device follows.
  await desktop.fill('#composer textarea', 'Weekend shopping\n- bread\n- apples\n- jacket for Ola');
  await desktop.keyboard.press('Control+Enter');
  const list = '.note:has(h3:text("Weekend shopping"))';
  await phone.waitForSelector(`${list} .list-count:text("☑ 0/3")`);
  assert.equal(await phone.locator('.note h3:text("bread")').count(), 0, 'items are not notes of their own');
  await phone.click(`${list} li:has-text("apples") [data-item-check]`);
  await desktop.waitForSelector(`${list} .list-count:text("☑ 1/3")`);
  await desktop.click(`${list} h3`);
  await desktop.waitForSelector('#itemsCount:text("1/3 done")');
  await desktop.fill('#newItem', 'milk');
  await desktop.press('#newItem', 'Enter');
  assert.ok(await desktop.isVisible('#editor[open]'), 'Enter adds an item and keeps the editor open');
  await desktop.waitForSelector('#itemsCount:text("1/4 done")');
  await desktop.selectOption('#itemList [data-item]:has([value="jacket for Ola"]) [data-item-priority]', 'urgent');
  // Open items first, the urgent one on top; done ones last.
  await desktop.waitForFunction(() => document.querySelector('#itemList [data-item] [data-item-text]').value === 'jacket for Ola');
  assert.equal(await desktop.inputValue('#itemList [data-item]:last-child [data-item-text]'), 'apples');
  await desktop.screenshot({ path: path.join(out, 'desktop-list-editor.png') });
  await desktop.click('#editorSave');
  await phone.waitForSelector(`${list} .list-count:text("☑ 1/4")`);
  await phone.waitForSelector(`${list} li.p-urgent:has-text("jacket for Ola")`);
  // Search finds a list by one of its items.
  await phone.fill('#search', 'milk');
  await phone.waitForSelector(`${list}`);
  await phone.screenshot({ path: path.join(out, 'phone-list.png') });
  await phone.fill('#search', '');
  console.log('✓ lists: items ticked, added and sorted, synced');

  // 7b. Dates: the AI found "tomorrow"; Nina picks a day and time herself,
  //     the phone follows, and the note goes to a calendar.
  const report = '.note:has(h3:text("Send the quarterly report tomorrow"))';
  await desktop.click(`${report} h3`);
  await desktop.waitForSelector('#whenHint:text("Found by AI")');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal(await desktop.inputValue('#editorDate'), tomorrow);
  await desktop.fill('#editorDate', '2030-05-14');
  await desktop.fill('#editorTime', '09:30');
  await desktop.waitForSelector('#whenHint:text("📌 Your choice")');
  const google = new URL(await desktop.getAttribute('#calGoogle', 'href'));
  assert.equal(google.searchParams.get('dates'), '20300514T093000/20300514T103000');
  assert.match(google.searchParams.get('text'), /^Send the quarterly report tomorrow/);
  await desktop.screenshot({ path: path.join(out, 'desktop-date.png') });
  const [download] = await Promise.all([desktop.waitForEvent('download'), desktop.click('#calFile')]);
  const ics = fs.readFileSync(await download.path(), 'utf8');
  assert.match(ics, /DTSTART:20300514T093000/);
  assert.match(download.suggestedFilename(), /\.ics$/);
  await desktop.click('#editorSave');
  await phone.waitForSelector(`${report} .due:text-matches("^📅 Tue, May 14, 2030 · 09:30 📌$")`);
  // Back to Auto: the AI's date returns.
  await desktop.click(`${report} h3`);
  await desktop.click('#whenAuto');
  assert.equal(await desktop.inputValue('#editorDate'), tomorrow);
  await desktop.click('#editorSave');
  await phone.waitForSelector(`${report} .due:text("📅 Tomorrow")`);
  // Connect a calendar: a private link that calendar apps read.
  await desktop.click('#accountBtn');
  await desktop.click('#calendarShow');
  await desktop.waitForSelector('#calendarLink:visible');
  const webcal = await desktop.getAttribute('#calendarApple', 'href');
  assert.match(webcal, /^webcal:\/\/localhost:\d+\/api\/calendar\/[\w-]+\.ics$/);
  assert.match(await desktop.getAttribute('#calendarGoogle', 'href'), /^https:\/\/calendar\.google\.com\/calendar\/render\?cid=webcal%3A/);
  const feed = await (await fetch(webcal.replace('webcal:', 'http:'))).text();
  assert.match(feed, /SUMMARY:Send the quarterly report tomorrow/);
  await desktop.screenshot({ path: path.join(out, 'desktop-calendar.png') });
  await desktop.click('#accountClose');
  console.log('✓ dates: own date and time, Auto, calendar file, calendar link');

  // 7c. Pasting several lines asks: a list (one item per line) or one note / one item.
  const paste = (page, sel, text) => page.evaluate(([sel, text]) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [sel, text]);
  await desktop.fill('#composer textarea', 'Pasta night\n');
  await desktop.evaluate(() => document.querySelector('#composer textarea').setSelectionRange(12, 12));
  await paste(desktop, '#composer textarea', '1. pasta\n2. tomatoes\n\n• basil');
  await desktop.waitForSelector('#pasteChoice[open] #pasteA:text("One note with a checklist (3 items)")');
  await desktop.screenshot({ path: path.join(out, 'desktop-paste.png') });
  await desktop.click('#pasteA');
  await desktop.waitForFunction(() => document.querySelector('#composer textarea').value === 'Pasta night\n- pasta\n- tomatoes\n- basil');
  await desktop.keyboard.press('Control+Enter');
  const pasta = '.note:has(h3:text("Pasta night"))';
  await desktop.waitForSelector(`${pasta} .list-count:text("☑ 0/3")`);
  await desktop.click(`${pasta} h3`);
  await paste(desktop, '#newItem', 'salt\npepper');
  assert.equal(await desktop.isVisible('#pastePlain'), false, 'no plain text choice for list items');
  await desktop.click('#pasteChoice #pasteB:text("Add as one item")');
  await desktop.waitForSelector('#itemList [data-item-text][value="salt, pepper"]');
  await paste(desktop, '#newItem', '- olive oil\n- parmesan');
  await desktop.click('#pasteChoice #pasteA:text("Add 2 items")');
  await desktop.waitForSelector('#itemsCount:text("0/6 done")');
  desktop.once('dialog', (d) => d.accept());
  await desktop.click('#editorDelete');
  // Separate notes: one note per line, each sorted by the AI.
  await paste(desktop, '#composer textarea', 'Call the bank\nBook the car service');
  await desktop.click('#pasteChoice #pasteB:text("2 separate notes")');
  await desktop.waitForSelector('.note h3:text("Call the bank")');
  await desktop.waitForSelector('.note h3:text("Book the car service")');
  assert.equal(await desktop.inputValue('#composer textarea'), '', 'nothing left in the box');
  // Plain text pastes it as it is; ✕ closes without pasting.
  await paste(desktop, '#composer textarea', 'line one\nline two');
  await desktop.click('#pasteChoice #pastePlain');
  await desktop.waitForFunction(() => document.querySelector('#composer textarea').value === 'line one\nline two');
  await desktop.fill('#composer textarea', '');
  await paste(desktop, '#composer textarea', 'line one\nline two');
  await desktop.click('#pasteChoice [title=Close]');
  await desktop.waitForSelector('#pasteChoice', { state: 'hidden' });
  assert.equal(await desktop.inputValue('#composer textarea'), '');
  // A checklist pasted without a title line gets one from the AI, not "List".
  await paste(desktop, '#composer textarea', 'eggs\nflour');
  await desktop.click('#pasteA');
  await desktop.waitForFunction(() => document.querySelector('#composer textarea').value === '- eggs\n- flour');
  await desktop.click('#composer [data-role=save]');
  await desktop.waitForSelector('.note:has(.list-count:text("☑ 0/2")):not(:has(.ai-pending))');
  assert.equal(await desktop.locator('.note h3:text-is("List")').count(), 0);
  for (const t of ['Call the bank', 'Book the car service']) {
    desktop.once('dialog', (d) => d.accept());
    await desktop.click(`.note h3:text("${t}")`);
    await desktop.click('#editorDelete');
  }
  desktop.once('dialog', (d) => d.accept());
  await desktop.click('.note:has(.list-count:text("☑ 0/2")) h3');
  await desktop.click('#editorDelete');
  // Clear done: right-click (two-finger click) or the button; asks first, Undo brings
  // everything back, lists with their items.
  await desktop.waitForSelector('#editor', { state: 'hidden' });
  await desktop.fill('#composer textarea', 'Old errands\n- post office\n- dry cleaning');
  await desktop.click('#composer [data-role=save]');
  const errands = '.note:has(h3:text("Old errands"))';
  await desktop.waitForSelector(`${errands} .list-count:text("☑ 0/2")`);
  await desktop.click(`${errands} [data-check]`);
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (2)")');
  desktop.once('dialog', (d) => d.dismiss());
  await desktop.click('[data-toggle-done]', { button: 'right' });
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (2)")');
  desktop.once('dialog', (d) => { assert.match(d.message(), /^Delete 2 done notes\?/); d.accept(); });
  await desktop.click('[data-clear-done]');
  await desktop.waitForSelector('[data-toggle-done]', { state: 'detached' });
  await phone.waitForSelector('[data-toggle-done]', { state: 'detached' });
  await desktop.screenshot({ path: path.join(out, 'desktop-cleared.png') });
  await desktop.click('.toast:has-text("2 done notes deleted") .toast-undo');
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (2)")');
  await phone.waitForSelector('[data-toggle-done]:text("Show done (2)")');
  await desktop.click('[data-toggle-done]');
  await desktop.waitForSelector(`.done-section ${errands} .list-count:text("☑ 0/2")`);
  await desktop.click(`${errands} [data-check]`);
  desktop.once('dialog', (d) => d.accept());
  await desktop.click(`${errands} h3`);
  await desktop.click('#editorDelete');
  await desktop.click('[data-toggle-done]');
  await desktop.waitForSelector('[data-toggle-done]:text("Show done (1)")');
  console.log('✓ clear done notes, with undo');
  console.log('✓ pasting several lines: a list, or one note / one item');

  // 8. Sharing: Nina shares the list with Tom before he has an account; he
  //    signs up with the invite code, ticks an item, then gets view only, then
  //    Nina stops sharing and the list leaves his phone.
  process.env.SIGNUP_CODE = 'family';
  await desktop.click(`${list} h3`);
  await desktop.click('#editorShare');
  await desktop.waitForSelector('#share[open] #shareTitle:text("Share \\"Weekend shopping\\"")');
  await desktop.waitForSelector('#sharePeople li:text("Not shared with anyone yet.")');
  await desktop.fill('#shareEmail', 'tom@example.com');
  await desktop.click('#shareSubmit');
  await desktop.waitForSelector('#sharePeople li:has-text("tom@example.com"):has-text("No account yet")');
  await desktop.click('#shareClose');
  await desktop.waitForSelector('#editorShared:text("Shared with tom@example.com")');
  await desktop.click('#editor [value=cancel]');
  await desktop.waitForSelector(`${list} .shared-badge:text("Shared")`);

  const tomCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const tom = (pages.tom = await tomCtx.newPage());
  watch(tom, 'tom');
  await tom.goto(url);
  await tom.waitForSelector('#login[open]');
  await tom.click('#loginSwitch [data-mode=signup]');
  await tom.fill('#loginName', 'Tom');
  await tom.fill('#loginEmail', 'tom@example.com');
  await tom.fill('#loginPassword', 'correct horse');
  await tom.fill('#loginCode', 'family');
  await tom.click('#loginSubmit');
  await tom.waitForSelector(`${list} .shared-badge:text("👥 Nina")`);
  assert.equal(await tom.locator('.note').count(), 1, "Tom sees only what's shared with him");
  await tom.click('.view-toggle [data-view=groups]');
  await tom.waitForSelector('.group h2:has-text("Shared with me")');
  await tom.click(`${list} li:has-text("bread") [data-item-check]`);
  await desktop.waitForSelector(`${list} .list-count:text("☑ 2/4")`);
  await tom.screenshot({ path: path.join(out, 'tom-shared-list.png') });

  // Nina makes it view only: Tom can still read it but not tick anything.
  await desktop.click(`${list} h3`);
  await desktop.click('#editorShare');
  await desktop.waitForSelector('#sharePeople li:has-text("Tom"):has-text("tom@example.com")');
  await desktop.selectOption('#sharePeople li:has-text("Tom") [data-share-role]', 'view');
  await tom.waitForSelector(`${list} .shared-badge:text("👥 Nina · view only")`);
  assert.ok(await tom.isDisabled(`${list} li:has-text("milk") [data-item-check]`));
  await tom.click(`${list} h3`);
  await tom.waitForSelector('#editorShared:text("Shared by Nina · view only")');
  assert.ok(await tom.isDisabled('#itemList [data-item-toggle] >> nth=0'));
  assert.equal(await tom.isVisible('#editorSave'), false);
  await tom.click('#editor [value=cancel]');
  await desktop.screenshot({ path: path.join(out, 'desktop-share.png') });

  // Nina stops sharing: the list disappears from Tom's phone.
  desktop.once('dialog', (d) => d.accept());
  await desktop.click('#sharePeople li:has-text("Tom") [data-share-remove]');
  await tom.waitForSelector(list, { state: 'detached' });
  await desktop.click('#shareClose');
  await desktop.click('#editor [value=cancel]');
  assert.equal(await desktop.locator(`${list} .shared-badge`).count(), 0);
  // Tom's AI sortings run on Nina's account: past his monthly limit, notes
  // are still saved, and he's told when sorting starts again.
  process.env.AI_MONTHLY_LIMIT = '1';
  await tom.fill('#composer textarea', 'Call the plumber');
  await tom.click('#composer [data-role=save]');
  await tom.waitForSelector('.note:has(h3:text("Call the plumber")):not(:has(.ai-pending))');
  await tom.fill('#composer textarea', 'Buy stamps');
  await tom.click('#composer [data-role=save]');
  await tom.waitForSelector('#limitBanner:visible:has-text("1 AI sortings are used up")');
  await tom.waitForSelector('.note:has(h3:text("Buy stamps")) .ai-limit');
  await tom.screenshot({ path: path.join(out, 'tom-ai-limit-banner.png') });
  await tom.click('#accountBtn');
  await tom.waitForSelector('#aiUsage:text("AI sortings this month: 1 of 1")');
  await tom.screenshot({ path: path.join(out, 'tom-ai-limit.png') });
  await tom.click('#accountClose');
  await desktop.click('#accountBtn');
  assert.equal(await desktop.isVisible('#aiUsage'), false, 'the owner has no limit');
  await desktop.click('#accountClose');
  delete process.env.AI_MONTHLY_LIMIT;
  console.log('✓ monthly AI limit for invited people');
  // A free account sees the Premium pitch (an A/B test) and can show interest.
  await tom.click('#accountBtn');
  await tom.waitForSelector('#pitchText:text-matches("backups|family", "i")');
  assert.equal(await tom.isVisible('#backupBox'), false);
  assert.equal(await tom.isVisible('#dashboardLink'), false, 'the dashboard is the owner\'s');
  await tom.click('#getPremium');
  await tom.waitForSelector('#premiumThanks:visible');
  await tom.click('#accountClose');
  // Onboarding: Tom (2 notes) still sees the welcome card; example notes fill his list.
  await tom.waitForSelector('#welcome');
  await tom.click('[data-welcome="examples"]');
  await tom.waitForSelector('.note h3:text("Groceries")');
  await tom.waitForSelector('.note h3:text("Dentist Tuesday 3pm")');
  await tom.waitForSelector('#welcome', { state: 'detached' });
  // Votes for coming Premium features, and feedback.
  await tom.click('#accountBtn');
  await tom.click('[data-interest="family_hub"]');
  await tom.waitForSelector('[data-interest="family_hub"].chosen');
  tom.once('dialog', (d) => d.accept('Love the shared lists!'));
  await tom.click('#sendFeedback');
  await tom.waitForSelector('.toast:has-text("Nina reads every message")');
  await tom.click('#accountClose');
  console.log('✓ onboarding, feature votes, feedback');
  // Tom deletes his account (typing his email confirms it).
  await tom.click('#accountBtn');
  tom.once('dialog', (d) => d.accept('tom@example.com'));
  await tom.click('#deleteAccount');
  await tom.waitForSelector('#login[open]');
  assert.equal(store.findUserByEmail('tom@example.com'), null);
  delete process.env.SIGNUP_CODE;
  await tomCtx.close();
  delete pages.tom;
  console.log('✓ sharing: shared before sign-up, ticked, view only, stopped');

  // 9. Appearance: on a device in dark mode, choose Light; it sticks after a reload.
  const bg = () => desktop.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await desktop.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await bg(), 'rgb(17, 17, 24)', 'Auto follows the dark device');
  await desktop.click('#accountBtn');
  await desktop.click('[data-theme-choice="light"]');
  assert.equal(await bg(), 'rgb(246, 246, 249)', 'Light chosen');
  await desktop.reload();
  await desktop.waitForSelector('.note h3');
  assert.equal(await bg(), 'rgb(246, 246, 249)', 'Light kept after reload');
  await desktop.click('#accountBtn');
  assert.ok(await desktop.isVisible('[data-theme-choice="light"].active'));
  await desktop.click('[data-theme-choice="auto"]');
  assert.equal(await bg(), 'rgb(17, 17, 24)', 'back to following the device');
  await desktop.click('#accountClose');
  await desktop.emulateMedia({ colorScheme: 'light' });
  console.log('✓ appearance: auto, light, dark');

  // Work and Family worlds: Work hides the shopping, a group can be moved.
  await desktop.fill('#composer textarea', 'Buy milk and eggs');
  await desktop.click('#composer [data-role=save]');
  await desktop.waitForSelector('.note:has(h3:text("Buy milk and eggs")):not(:has(.ai-pending))');
  await desktop.click('.world-toggle [data-world=work]');
  await desktop.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
  await desktop.waitForSelector('.note h3:text("Buy milk and eggs")', { state: 'detached' }); // shopping is not work
  await desktop.click('.world-toggle [data-world=family]');
  await desktop.waitForSelector('.note h3:text("Buy milk and eggs")');
  await desktop.waitForSelector('.note h3:text("Send the quarterly report tomorrow")', { state: 'detached' }); // work is not family
  await desktop.screenshot({ path: path.join(out, 'desktop-family.png') });
  await desktop.click('.world-toggle [data-world=all]');
  await desktop.click('.view-toggle [data-view=groups]');
  await desktop.click('[data-world-group="Shopping"]');
  await desktop.waitForSelector('[data-world-group="Shopping"]:text("Both")');
  await desktop.click('.world-toggle [data-world=work]');
  await desktop.waitForSelector('.note h3:text("Buy milk and eggs")');
  await desktop.click('.world-toggle [data-world=all]');
  await desktop.click('[data-world-group="Shopping"]');
  await desktop.click('[data-world-group="Shopping"]');
  await desktop.waitForSelector('[data-world-group="Shopping"]:text("Family")');
  await desktop.click('.view-toggle [data-view=priority]');
  console.log('✓ work and family worlds, a group moved between them');

  // Today: notes due today, with their time, at the top; a tap opens one.
  await desktop.fill('#composer textarea', 'Pick up Mia at 16:00');
  await desktop.click('#composer [data-role=save]');
  await desktop.click('.note:has(h3:text("Pick up Mia at 16:00"))');
  await desktop.waitForSelector('#editor[open]');
  const todayIso = await desktop.evaluate(() => new Date().toLocaleDateString('en-CA'));
  await desktop.fill('#editorDate', todayIso);
  await desktop.fill('#editorTime', '16:00');
  await desktop.click('#editorSave');
  await desktop.waitForSelector('.today:has-text("16:00 Pick up Mia")');
  await desktop.click('.today [data-open]:has-text("Pick up Mia")');
  await desktop.waitForSelector('#editor[open]');
  await desktop.click('#editorSave');
  await desktop.screenshot({ path: path.join(out, 'desktop-today.png') });
  console.log('✓ today at the top: what is due, with times');

  // Premium backups (the owner has Premium): back up, delete a note, restore it.
  await desktop.fill('#composer textarea', 'Passport renewal form');
  await desktop.click('#composer [data-role=save]');
  await desktop.waitForSelector('.note h3:text("Passport renewal form")');
  await desktop.click('#accountBtn');
  await desktop.waitForSelector('#backupBox:visible');
  await desktop.click('#backupNow');
  await desktop.waitForSelector('#backupList li:has-text("By hand")');
  await desktop.screenshot({ path: path.join(out, 'desktop-backups.png') });
  await desktop.click('#accountClose');
  desktop.once('dialog', (d) => d.accept());
  await desktop.click('.note h3:text("Passport renewal form")');
  await desktop.click('#editorDelete');
  await phone.waitForSelector('.note h3:text("Passport renewal form")', { state: 'detached' });
  await desktop.click('#accountBtn');
  desktop.once('dialog', (d) => d.accept());
  await desktop.click('#backupList li:has-text("By hand") [data-restore]');
  await desktop.waitForSelector('.toast:has-text("Restored")');
  await desktop.click('#accountClose');
  await desktop.waitForSelector('.note h3:text("Passport renewal form")');
  await phone.waitForSelector('.note h3:text("Passport renewal form")');
  // Download all my notes (everyone can).
  await desktop.click('#accountBtn');
  const [exp] = await Promise.all([desktop.waitForEvent('download'), desktop.click('#exportNotes')]);
  assert.match(exp.suggestedFilename(), /^record-ai-notes-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  // The owner's dashboard.
  await desktop.click('#dashboardLink');
  await desktop.waitForSelector('#tiles .tile');
  await desktop.waitForSelector('#experiments :text("premium_pitch")');
  await desktop.waitForSelector('#users select[data-email="nina@example.com"]');
  await desktop.waitForSelector('#tiles .tile:has-text("Get Premium") .v:text("1")');
  await desktop.waitForSelector('#interest td:text("👨‍👩‍👧 Give tasks to family")');
  await desktop.waitForSelector('#feedback :text("Love the shared lists!")');
  await desktop.screenshot({ path: path.join(out, 'desktop-dashboard.png'), fullPage: true });
  await desktop.goBack();
  await desktop.waitForSelector('.note h3');
  console.log('✓ premium backups, restore, download, dashboard');

  // Every note finishes AI processing on both devices.
  for (const p of [desktop, phone]) {
    await p.waitForFunction(() => !document.querySelector('.ai-pending'), null, { timeout: 5000 }).catch(async (e) => {
      console.log(await p.evaluate(() => [...document.querySelectorAll('.note:has(.ai-pending) h3')].map((h) => h.textContent)));
      console.log(JSON.stringify(store.db.prepare('SELECT text, ai_status, edited_at FROM notes').all()));
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

  // 7. Log back in on the phone with "Continue with Google". Google's page is
  //    faked: it sends the browser straight back with a sign-in code.
  await phone.waitForSelector('#providerButtons a:text("Continue with Google")');
  await phone.waitForSelector('#providerButtons a:text("Continue with GitHub")');
  await phone.screenshot({ path: path.join(out, 'phone-login.png') });
  // (Playwright cannot catch the redirect to Google itself, so it catches the
  // app's start link, reads where it would go, and plays Google's part.)
  await phone.route('**/api/auth/oauth/google/start*', async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const q = new URL(res.headers().location).searchParams;
    assert.equal(q.get('client_id'), 'e2e');
    const back = `${q.get('redirect_uri')}?state=${q.get('state')}&code=e2e-code`;
    // Keep the cookie that ties this sign-in to this browser.
    await route.fulfill({ status: 302, headers: { location: back, 'set-cookie': res.headers()['set-cookie'] } });
  });
  await phone.click('#providerButtons a:text("Continue with Google")');
  await phone.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
  await phone.waitForSelector('.sync-dot.ok');
  assert.equal(new URL(phone.url()).search, '', 'address bar tidied');
  await phone.click('#accountBtn');
  await phone.waitForSelector('#identityList li:has-text("Google") [data-disconnect]');
  await phone.waitForSelector('#identityList li:has-text("GitHub") a:text("Connect")');
  await phone.screenshot({ path: path.join(out, 'phone-signin-options.png') });
  await phone.click('#accountClose');
  console.log('✓ continue with Google logs into the same account');

  // 8. Forgot password: a link by email, a new password, logged in.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    watch(page, 'reset');
    await page.goto(url);
    await page.waitForSelector('#login[open]');
    await page.fill('#loginEmail', 'nina@example.com');
    await page.click('#forgotBtn');
    await page.waitForSelector('#reset[open] #resetEmail');
    assert.equal(await page.inputValue('#resetEmail'), 'nina@example.com', 'the email is carried over');
    await page.click('#resetSubmit');
    await page.waitForSelector('#resetMessage:has-text("a link is on its way")');
    const link = mails.at(-1).text.match(/https?:\/\/\S+#reset=\S+/)[0];
    await page.goto(link);
    await page.reload(); // a link opened in a new tab loads the page fresh
    await page.waitForSelector('#reset[open] #resetPassword');
    await page.fill('#resetPassword', 'a brand new password');
    await page.click('#resetSubmit');
    await page.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
    assert.ok(!(await page.locator('#reset[open], #login[open]').count()), 'no login window left');
    assert.equal(new URL(page.url()).hash, '', 'the code leaves the address bar');
    await ctx.close();
  }
  console.log('✓ forgot password: email link, new password, logged in');

  // 9. Seven languages: the browser's language first, then the one chosen in the account menu.
  {
    const ctx = await browser.newContext({ locale: 'it-IT' });
    const page = await ctx.newPage();
    watch(page, 'italian');
    await page.goto(url);
    await page.waitForSelector('#login[open] #loginSubmit:text("Accedi")');
    await page.fill('#loginEmail', 'nina@example.com');
    await page.fill('#loginPassword', 'a brand new password');
    await page.click('#loginSubmit');
    await page.waitForSelector('.note h3:text("Send the quarterly report tomorrow")');
    assert.equal(await page.getAttribute('#search', 'placeholder'), 'Cerca nelle note…');
    assert.equal(await page.evaluate(() => fetch('api/language').then((r) => r.json()).then((r) => r.lang)), 'it', 'the account learns the language');
    // A reminder, set in the editor under the date.
    const rid = await page.evaluate(async () => {
      const id = crypto.randomUUID();
      const now = Date.now();
      await fetch(`api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Call the plumber', user_due: '2030-01-02T10:00', created_at: now, edited_at: now }) });
      return id;
    });
    await page.click('.note h3:text("Call the plumber")');
    await page.waitForSelector('#remindRow:not([hidden])');
    assert.equal(await page.textContent('#editorRemind option[value="15"]'), '15 minuti prima');
    await page.selectOption('#editorRemind', '15');
    await page.click('#editorSave');
    await page.waitForFunction(async (id) => (await (await fetch('api/notes?since=0')).json()).notes.find((n) => n.id === id)?.remind === 15, rid);
    await page.click('#accountBtn');
    await page.waitForSelector('#account[open] h3:text("Lingua")');
    await page.waitForSelector('#notifyBox h3:text("🔔 Notifiche")');
    await Promise.all([page.waitForEvent('load'), page.selectOption('#langSelect', 'pl')]);
    await page.waitForSelector('#search[placeholder="Szukaj notatek…"]');
    assert.equal(await page.evaluate(() => fetch('api/language').then((r) => r.json()).then((r) => r.lang)), 'pl');
    assert.equal(await page.inputValue('#langSelect'), 'pl');
    await page.screenshot({ path: path.join(out, 'polish.png') });
    await ctx.close();
  }
  console.log('✓ seven languages: Italian from the browser, Polish from the menu; a reminder set in the editor');

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
