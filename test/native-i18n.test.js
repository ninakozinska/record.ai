// The iPhone and Android apps: every phrase translated, and the tables up to date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('the apps\' translation tables are complete and up to date', () => {
  const out = execFileSync(process.execPath, ['scripts/native-i18n.mjs', 'check'], { encoding: 'utf8' });
  assert.match(out, /all in 6 languages/);
});
