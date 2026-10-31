// The person's language: kept per account, and passed to the AI so new
// groups get names in that language (titles follow each note's language).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './helpers.js';
import { openDb } from '../server/db.js';
import { Organizer } from '../server/organizer.js';

const put = (s, lang) => s.api('language', { method: 'PUT', body: JSON.stringify({ lang }) });

test('the language is kept per account and only from the supported seven', async () => {
  const s = await start();
  try {
    const first = (await s.api('language')).body;
    assert.equal(first.lang, null);
    assert.deepEqual(Object.keys(first.languages), ['en', 'it', 'fr', 'es', 'pt', 'de', 'pl']);
    assert.equal((await put(s, 'xx')).status, 400);
    assert.equal((await put(s, 'it')).body.lang, 'it');
    assert.equal((await s.api('language')).body.lang, 'it');
  } finally {
    s.close();
  }
});

test('the AI is told the language when it sorts a note', async () => {
  const prompts = [];
  const client = { beta: { messages: { parse: async (p) => {
    prompts.push(p.messages[0].content.at(-1).text);
    return { stop_reason: 'end_turn', parsed_output: { title: 'Latte', summary: 'Comprare il latte', group: 'Spesa', priority: 'normal', priority_reason: 'nessuna fretta', tags: [], due_date: null, due_time: null } };
  } } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-lang-'));
  const store = openDb(dir);
  const nina = store.createUser({ email: 'nina@example.com', name: 'Nina', pwHash: 'x' });
  const organizer = new Organizer({ store, imagesDir: dir, onChange() {}, client, log: { error() {} } });
  store.upsertFromClient(nina.id, { id: 'note-lang-0001', text: 'comprare il latte', edited_at: 1 });
  await organizer.organizeNote('note-lang-0001');
  assert.doesNotMatch(prompts[0], /The person's language/, 'not chosen yet: the AI follows the notes');
  store.setLanguage(nina.id, 'it');
  store.upsertFromClient(nina.id, { id: 'note-lang-0002', text: 'dentista martedi', edited_at: 2 });
  await organizer.organizeNote('note-lang-0002');
  assert.match(prompts[1], /The person's language: Italian\. Name any new group in Italian\./);
  assert.equal(store.get('note-lang-0002').ai_group, 'Spesa');
});

test('the reset email is in the account\'s language, else the browser\'s', async () => {
  const { mailLanguage, resetEmail } = await import('../server/mail.js');
  assert.equal(mailLanguage('pl', 'it-IT,it;q=0.9'), 'pl');
  assert.equal(mailLanguage(null, 'fr-CH, fr;q=0.9, en;q=0.8'), 'fr');
  assert.equal(mailLanguage(null, 'ja-JP'), 'en');
  const it = resetEmail('it', { name: 'Nina', link: 'https://x/#reset=abc' });
  assert.equal(it.subject, 'Reimposta la password di record.ai');
  assert.match(it.text, /^Ciao Nina,[\s\S]*https:\/\/x\/#reset=abc/);
});
