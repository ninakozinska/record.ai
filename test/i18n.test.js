// The seven languages of the web app: nothing missing, nothing broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LANGS = ['en', 'it', 'fr', 'es', 'pt', 'de', 'pl'];
const dicts = Object.fromEntries(await Promise.all(LANGS.map(async (l) => [l, (await import(`../public/i18n/${l}.js`)).default])));
const placeholders = (s) => [...new Set(s.match(/\{\w+\}/g) || [])].sort();

test('every phrase the web app asks for is in the English list', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const asked = [...app.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2].replace(/\\n/g, '\n').replace(/\\(['"])/g, '$1'));
  // Also both phrases of t(choice ? 'one' : 'other', …).
  for (const m of app.matchAll(/\bt\([^()'"`]*\?\s*'([^']*)'\s*:\s*'([^']*)'/g)) asked.push(m[1], m[2]);
  assert.ok(asked.length > 150);
  const missing = asked.filter((k) => !(k in dicts.en));
  assert.deepEqual(missing, []);
});

test('the page and the picker have their words in the English list', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const k of ['Appearance', 'Language', 'Search notes…', 'Forgot your password?', 'Delete my account']) {
    assert.ok(html.includes(k), k);
    assert.ok(k in dicts.en, k);
  }
});

for (const l of LANGS.slice(1)) {
  test(`${l}: every phrase translated, with the same {names} and the plural forms of the language`, () => {
    const forms = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    assert.deepEqual(Object.keys(dicts[l]).sort(), Object.keys(dicts.en).sort());
    for (const [key, value] of Object.entries(dicts[l])) {
      if (typeof value === 'string') {
        assert.ok(value.trim(), `${l} "${key}" is empty`);
        assert.deepEqual(placeholders(value), placeholders(key), `${l} "${key}"`);
      } else {
        for (const f of forms.filter((f) => f !== 'many' || l === 'pl')) assert.ok(value[f] || value.other, `${l} "${key}" needs "${f}"`);
        for (const v of Object.values(value)) assert.deepEqual(placeholders(v), placeholders(key), `${l} "${key}"`);
      }
    }
  });
}
