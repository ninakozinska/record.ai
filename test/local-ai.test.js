import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { Organizer, friendlyError } from '../server/organizer.js';
import { ensureOllamaModel } from '../server/ollama.js';

const quiet = { log() {}, warn() {}, error() {} };

/** Minimal stand-in for Ollama's HTTP API. */
async function fakeOllama({ models = ['gemma3:4b'], reply } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, body: json });
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }));
    if (req.url === '/api/pull') {
      for (const line of [{ status: 'pulling' }, { status: 'pulling', total: 100, completed: 50 }, { status: 'pulling', total: 100, completed: 100 }, { status: 'success' }]) {
        res.write(JSON.stringify(line) + '\n');
      }
      models.push(json.model);
      return res.end();
    }
    if (req.url === '/api/chat') {
      if (!models.includes(json.model)) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `model "${json.model}" not found, try pulling it first` }));
      }
      return res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(reply(json)) }, done: true }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function setup(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-local-'));
  fs.mkdirSync(path.join(dir, 'images'));
  const store = openDb(dir);
  const changes = [];
  const organizer = new Organizer({ store, imagesDir: path.join(dir, 'images'), onChange: (n) => changes.push(n), log: quiet });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { dir, store, organizer, restore };
}

const analysis = { title: 'Pay bill', summary: 's', group: 'Home', priority: 'high', priority_reason: 'r', tags: ['bills'], due_date: null };

test('local AI (Ollama) organizes a note with text and photo', async () => {
  const ollama = await fakeOllama({ reply: () => analysis });
  const t = setup({ AI_PROVIDER: 'ollama', OLLAMA_URL: ollama.url, OLLAMA_MODEL: undefined });
  try {
    fs.writeFileSync(path.join(t.dir, 'images', 'aaaaaaaa-1111.jpg'), Buffer.from([1, 2, 3]));
    t.store.upsertFromClient({ id: 'note-local-1', text: 'pay the bill', images: ['aaaaaaaa-1111.jpg'], edited_at: 1 });
    assert.equal(t.organizer.status.enabled, true);
    assert.equal(t.organizer.status.model, 'gemma3:4b');
    await t.organizer.organizeNote('note-local-1');
    const n = t.store.get('note-local-1');
    assert.equal(n.ai_status, 'done');
    assert.equal(n.group, 'Home');
    assert.equal(n.priority, 'high');

    const chat = ollama.requests.find((r) => r.url === '/api/chat').body;
    assert.equal(chat.model, 'gemma3:4b');
    assert.equal(chat.stream, false);
    assert.equal(chat.format.type, 'object');
    assert.ok(chat.format.properties.priority.enum.includes('urgent'));
    assert.equal(chat.messages[0].role, 'system');
    assert.deepEqual(chat.messages[1].images, [Buffer.from([1, 2, 3]).toString('base64')]);
    assert.match(chat.messages[1].content, /pay the bill/);
  } finally {
    t.restore();
    ollama.close();
  }
});

test('local AI: bad answers and missing Ollama give clear errors', async () => {
  const ollama = await fakeOllama({ reply: () => ({ title: 'only a title' }) });
  const t = setup({ AI_PROVIDER: 'ollama', OLLAMA_URL: ollama.url, OLLAMA_MODEL: undefined });
  try {
    t.store.upsertFromClient({ id: 'note-local-2', text: 'x', edited_at: 1 });
    await t.organizer.organizeNote('note-local-2');
    assert.equal(t.store.get('note-local-2').ai_status, 'error');
    assert.match(t.store.get('note-local-2').ai_error, /incomplete answer/);
    assert.equal(t.store.get('note-local-2').group, 'Inbox', 'note stays usable');

    process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens here
    t.store.applyAi('note-local-2', { status: 'pending' });
    await t.organizer.organizeNote('note-local-2');
    assert.match(t.store.get('note-local-2').ai_error, /Ollama\) is not running/);
  } finally {
    t.restore();
    ollama.close();
  }
});

test('ensureOllamaModel downloads a missing model once', async () => {
  const ollama = await fakeOllama({ models: [] });
  const t = setup({ OLLAMA_URL: ollama.url, OLLAMA_MODEL: 'gemma3:4b' });
  const lines = [];
  try {
    assert.equal(await ensureOllamaModel({ log: { log: (m) => lines.push(m), warn: (m) => lines.push(m) } }), true);
    assert.ok(lines.some((l) => /Downloading/.test(l)));
    assert.ok(lines.some((l) => /100%/.test(l)));
    const pulls = ollama.requests.filter((r) => r.url === '/api/pull').length;
    assert.equal(await ensureOllamaModel({ log: quiet }), true);
    assert.equal(ollama.requests.filter((r) => r.url === '/api/pull').length, pulls, 'no second download');
  } finally {
    t.restore();
    ollama.close();
  }
});

test('ensureOllamaModel reports when Ollama is not running', async () => {
  const t = setup({ OLLAMA_URL: 'http://127.0.0.1:9' });
  const warnings = [];
  try {
    assert.equal(await ensureOllamaModel({ log: { log() {}, warn: (m) => warnings.push(m) }, waitSeconds: 0 }), false);
    assert.match(warnings[0], /not running/);
  } finally {
    t.restore();
  }
});

test('AI_PROVIDER=none turns the AI off even with a key', () => {
  const t = setup({ AI_PROVIDER: 'none', ANTHROPIC_API_KEY: 'sk-ant-test' });
  try {
    assert.equal(t.organizer.enabled, false);
  } finally {
    t.restore();
  }
});

test('notes that failed earlier are retried when the app starts with AI on', async () => {
  const ollama = await fakeOllama({ reply: () => analysis });
  const t = setup({ AI_PROVIDER: 'ollama', OLLAMA_URL: ollama.url, OLLAMA_MODEL: undefined });
  try {
    t.store.upsertFromClient({ id: 'note-local-3', text: 'x', edited_at: 1 });
    t.store.applyAi('note-local-3', { status: 'error', error: 'no credit' });
    t.organizer.resumePending();
    for (let i = 0; i < 100 && t.store.get('note-local-3').ai_status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.store.get('note-local-3').ai_status, 'done');
  } finally {
    t.restore();
    ollama.close();
  }
});

test('Claude billing errors are explained in plain words', () => {
  const msg = friendlyError(new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), 'anthropic');
  assert.match(msg, /no credit/);
});
