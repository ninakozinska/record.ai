// The password-reset command and the Mac launchers (run with stand-ins for
// the macOS-only commands, so this works on Linux too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { hashPassword, verifyPassword } from '../server/auth.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('npm run reset-password sets a new password and logs out everywhere', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-reset-'));
  const store = openDb(dir);
  const user = store.createUser({ email: 'nina@example.com', name: 'Nina', pwHash: await hashPassword('old password') });
  const token = store.createSession(user.id);
  const run = (...args) =>
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/reset-password.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8',
      stdio: 'pipe',
    });

  assert.throws(() => run('nina@example.com', 'short'), /at least 8/);
  assert.throws(() => run('nobody@example.com', 'long enough'), /No account/);
  assert.throws(() => run(), /Usage/);
  assert.match(run('NINA@example.com', 'brand new password'), /Password changed/);

  const fresh = openDb(dir);
  assert.ok(await verifyPassword('brand new password', fresh.passwordHash(user.id)));
  assert.equal(fresh.sessionUser(token), null);
});

/** Copies the launcher files into a temp folder with fake macOS commands. */
function macSandbox(choice) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-mac-'));
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  for (const f of ['Start record.ai.command', 'Change AI.command', 'scripts/mac-common.sh', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  }
  fs.mkdirSync(path.join(app, 'node_modules'));
  fs.mkdirSync(path.join(app, 'server'));
  // A tiny stand-in server that answers /api/health and prints its AI setting.
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  fs.writeFileSync(path.join(app, 'server.js'), `
    const fs = require('fs');
    for (const l of fs.readFileSync('.env', 'utf8').split('\\n')) if (l.startsWith('AI_PROVIDER=')) console.log('started with', l);
    require('http').createServer((q, r) => r.end('{"ok":true}')).listen(Number(process.env.PORT || 3000));`);
  fs.utimesSync(path.join(app, 'node_modules'), new Date(), new Date(Date.now() + 60e3));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('osascript', `echo "$*" >> "${dir}/dialogs.log"\ncase "$*" in *"Which AI"*) echo "${choice}";; *API*) echo sk-ant-api03-TEST;; esac`);
  stub('open', `echo "open $*" >> "${dir}/dialogs.log"`);
  stub('caffeinate', 'shift; exec "$@"');
  stub('ipconfig', 'exit 1');
  stub('lsof', 'exit 1');
  stub('ollama', 'exit 0');
  return { dir, app, bin };
}

function runUntil(cmd, sandbox, port, pattern) {
  return new Promise((resolve, reject) => {
    // Own process group, so the server and the launcher's helpers stop together.
    const child = spawn('bash', [cmd], {
      cwd: sandbox.app,
      detached: true,
      env: { ...process.env, PATH: `${sandbox.bin}:${process.env.PATH}`, PORT: String(port) },
    });
    let out = '';
    const stop = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => { stop(); reject(new Error(`timeout; output:\n${out}`)); }, 15000);
    const onData = (d) => {
      out += d;
      if (pattern.test(out)) { clearTimeout(timer); stop(); resolve(out); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

const hasBash = (() => { try { execFileSync('bash', ['-c', 'true']); return true; } catch { return false; } })();

test('Mac launcher: asks which AI to use, saves it, and starts the server', { skip: !hasBash }, async () => {
  const sb = macSandbox('Free on this Mac');
  // An existing settings file from before accounts existed.
  fs.writeFileSync(path.join(sb.app, '.env'), 'APP_PASSWORD=old\nANTHROPIC_API_KEY=sk-ant-api03-OLD\n');
  const out = await runUntil(path.join(sb.app, 'Start record.ai.command'), sb, 39011, /started with AI_PROVIDER=ollama/);
  assert.match(out, /On this Mac:\s+http:\/\/localhost:39011/);
  const env = fs.readFileSync(path.join(sb.app, '.env'), 'utf8');
  assert.match(env, /^AI_PROVIDER=ollama$/m);
  assert.match(env, /ANTHROPIC_API_KEY=sk-ant-api03-OLD/, 'existing key kept');
  const dialogs = fs.readFileSync(path.join(sb.dir, 'dialogs.log'), 'utf8');
  assert.match(dialogs, /Which AI/);
  assert.doesNotMatch(dialogs, /password/i, 'no password question any more: accounts are made in the app');
});

test('Change AI: switching to Claude stores the cheap model and asks for a key if missing', { skip: !hasBash }, async () => {
  const sb = macSandbox('Claude online (cheap)');
  fs.writeFileSync(path.join(sb.app, '.env'), 'AI_PROVIDER=ollama\n');
  await runUntil(path.join(sb.app, 'Change AI.command'), sb, 39012, /started with AI_PROVIDER=anthropic/);
  const env = fs.readFileSync(path.join(sb.app, '.env'), 'utf8');
  assert.match(env, /^AI_PROVIDER=anthropic$/m);
  assert.match(env, /^CLAUDE_MODEL=claude-haiku-5-5$/m);
  assert.match(env, /^ANTHROPIC_API_KEY=sk-ant-api03-TEST$/m);
  assert.equal((fs.statSync(path.join(sb.app, '.env')).mode & 0o077), 0, 'settings file is private to the user');
});

test('the demo account for app reviewers: Premium, example notes, never the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-ai-demo-'));
  const run = (...args) =>
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/demo-account.mjs', ...args], {
      cwd: ROOT, env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', stdio: 'pipe',
    });
  assert.throws(() => run('review@example.com', 'long enough pw'), /first account/);
  openDb(dir).createUser({ email: 'nina@example.com', name: 'Nina', pwHash: 'x' });
  assert.match(run('review@example.com', 'long enough pw'), /Demo account ready/);
  assert.match(run('review@example.com', 'another long pw'), /Demo account ready/, 'runs again');
  const store = openDb(dir);
  const demo = store.findUserByEmail('review@example.com');
  assert.equal(store.planOf(demo.id), 'family');
  assert.ok(await verifyPassword('another long pw', store.passwordHash(demo.id)));
  const notes = store.changesSince(demo.id, 0, { items: false }).filter((n) => !n.deleted);
  assert.equal(notes.length, 5, 'the old examples were replaced');
  assert.equal(store.items(notes.find((n) => n.title === 'Groceries').id).length, 4);
  assert.notEqual(store.firstUserId(), demo.id);
});
