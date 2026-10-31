// Adds phrases to the web app's dictionaries (public/i18n/*.js).
//   node scripts/i18n-add.mjs phrases.json
// phrases.json: { "English phrase": { "it": "…", "fr": "…", "es": "…", "pt": "…", "de": "…", "pl": "…" } }
// A phrase that is already there is replaced. Plural phrases: give an object
// of forms instead of a string ({ "one": "…", "other": "…" }; Polish adds few and many).
import fs from 'node:fs';

const LANGS = ['en', 'it', 'fr', 'es', 'pt', 'de', 'pl'];
const phrases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const lang of LANGS) {
  const file = new URL(`../public/i18n/${lang}.js`, import.meta.url);
  const src = fs.readFileSync(file, 'utf8');
  const head = src.slice(0, src.indexOf('export default {'));
  const dict = (await import(`${file.href}?${Date.now()}`)).default;
  for (const [key, tr] of Object.entries(phrases)) {
    const value = lang === 'en' ? tr.en ?? key : tr[lang];
    if (value == null) throw new Error(`"${key}" has no ${lang} translation`);
    dict[key] = value;
  }
  const body = Object.entries(dict).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  fs.writeFileSync(file, `${head}export default {\n${body},\n};\n`);
}
console.log(`${Object.keys(phrases).length} phrases added in ${LANGS.length} languages`);
