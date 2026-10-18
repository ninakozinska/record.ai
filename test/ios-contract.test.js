// Replays the requests the iPhone app (ios/RecordAI.swiftpm) makes, so the
// server can't drift away from what the app expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.js';

test('iPhone app protocol: token login, notes, photos, live updates', async () => {
  const s = await start({ noSignup: true });
  const base = s.base.replace(/\/api\/$/, '');
  // API.normalize + checkServer: GET /api/health -> { ok: true }
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);

  const call = async (path, { method = 'GET', json, body, type, token } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    if (body) headers['Content-Type'] = type;
    const res = await fetch(`${base}/api/${path}`, { method, headers, body: json ? JSON.stringify(json) : body });
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
  };

  try {
    // LoginView: auth/state, then signup (no cookies, token only)
    const state = await call('auth/state');
    assert.deepEqual(Object.keys(state.data).sort(), ['signup', 'user']);
    assert.equal(state.data.signup.firstAccount, true);
    const signup = await call('auth/signup', { method: 'POST', json: { name: 'Nina Kozinska', email: 'nina@example.com', password: 'correct horse', code: '' } });
    assert.equal(signup.status, 200);
    const { token, user } = signup.data;
    assert.ok(token && user.id && user.name && user.email);

    // NoteStore.addImage + flush: PUT image as JPEG
    const img = `${crypto.randomUUID()}.jpg`;
    assert.equal((await call(`images/${img}`, { method: 'PUT', body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), type: 'image/jpeg', token })).status, 200);

    // NoteStore.save: new note (millisecond timestamps as numbers)
    const id = crypto.randomUUID().toLowerCase();
    const now = Date.now();
    const saved = await call(`notes/${id}`, { method: 'PUT', json: { created_at: now, text: 'buy milk', images: [img], edited_at: now }, token });
    assert.equal(saved.status, 200);
    const note = saved.data.note;
    for (const k of ['id', 'text', 'images', 'done', 'deleted', 'created_at', 'edited_at']) assert.ok(k in note, `note has ${k}`);
    assert.equal(saved.data.stale, false);

    // NoteDetailView: pin a group, then clear it again with null (NSNull)
    let r = await call(`notes/${id}`, { method: 'PUT', json: { created_at: now, user_group: 'Home', user_priority: 'high', edited_at: now + 1 }, token });
    assert.equal(r.data.note.group, 'Home');
    r = await call(`notes/${id}`, { method: 'PUT', json: { created_at: now, user_group: null, user_priority: null, edited_at: now + 2 }, token });
    assert.equal(r.data.note.user_group, null);
    assert.equal(r.data.note.user_priority, null);

    // NoteStore.pull
    const page = await call('notes?since=0', { token });
    assert.equal(page.data.notes.length, 1);
    assert.equal(typeof page.data.rev, 'number');

    // NoteStore.image(named:)
    const got = await call(`images/${img}`, { token });
    assert.equal(got.status, 200);
    assert.equal(new Uint8Array(got.data)[0], 0xff);

    // API.events(): "event:" line then a single "data:" line per message
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events = [];
    const readUntil = async (pred) => {
      while (!pred()) {
        const { value } = await reader.read();
        buf += decoder.decode(value, { stream: true });
        let event = 'message';
        events.length = 0;
        for (const line of buf.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) { events.push([event, JSON.parse(line.slice(5).trim())]); event = 'message'; }
        }
      }
    };
    await readUntil(() => events.some(([e]) => e === 'hello'));
    assert.equal(typeof events[0][1].ai.enabled, 'boolean');
    await call(`notes/${id}`, { method: 'PUT', json: { done: true, edited_at: now + 3 }, token });
    await readUntil(() => events.some(([e, d]) => e === 'note' && d.done === true));
    ctrl.abort();

    // AccountView: change password, logout
    assert.equal((await call('auth/password', { method: 'POST', json: { current: 'correct horse', next: 'battery staple' }, token })).status, 200);
    assert.equal((await call('auth/logout', { method: 'POST', json: {}, token })).status, 200);
    assert.equal((await call('notes?since=0', { token })).status, 401);
    // After 401 the app asks auth/state again and shows the login screen.
    assert.equal((await call('auth/state', { token })).data.user, null);
  } finally {
    s.close();
  }
});
