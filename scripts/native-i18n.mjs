// The iPhone and Android apps in seven languages, from the same dictionaries
// as the web app (public/i18n/*.js) plus the phrases only the apps use
// (scripts/native-phrases.json).
//
//   node scripts/native-i18n.mjs wrap    puts tr("…") around the words people see
//   node scripts/native-i18n.mjs build   writes the apps' translation tables
//   node scripts/native-i18n.mjs check   fails if a table is out of date or a phrase is missing
//
// In the apps, tr("Save") gives the phrase in the phone's language (English
// when the phone uses another language). Phrases with a value inside
// ("\(n) notes", "$n notes") stay English for now.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LANGS = ['it', 'fr', 'es', 'pt', 'de', 'pl'];
const SWIFT_DIRS = ['ios/RecordAI.swiftpm/Views', 'ios/RecordAI.swiftpm/RecordAIApp.swift', 'ios/RecordAI.swiftpm/Worlds.swift'];
const KOTLIN_DIRS = ['android/app/src/main/kotlin/ai/record/android/ui', 'android/core/src/main/kotlin/ai/record/core/Worlds.kt'];
const SWIFT_OUT = 'ios/RecordAI.swiftpm/Translations.swift';
const KOTLIN_OUT = 'android/core/src/main/kotlin/ai/record/core/Translations.kt';
const NATIVE = 'scripts/native-phrases.json';

const files = (entries, ext) => entries.flatMap((e) => {
  const p = path.join(ROOT, e);
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p).filter((f) => f.endsWith(ext)).map((f) => path.join(p, f));
});
const sources = () => [...files(SWIFT_DIRS, '.swift'), ...files(KOTLIN_DIRS, '.kt')];

const LITERAL = /(?<![\w"])"((?:[^"\\\n]|\\.)*)"/g;
const NOT_WORDS = new Set(['Bearer', 'Authorization', 'Content-Type', 'GET', 'POST', 'PUT', 'DELETE', 'JSON', 'UTF-8', 'record.ai']);

/** Words a person reads, not a key, a format or a name in the code. */
function isWords(s) {
  if (s.length < 2 || !/[A-Za-z]/.test(s) || NOT_WORDS.has(s)) return false;
  if (/\\[bdswnt]|\|/.test(s)) return false; // escapes and patterns, not words
  if (/\\\(|\$/.test(s)) return false; // a value inside: stays English
  if (/^\s/.test(s)) return /^\s+[(·–-]?\s*[A-Za-z]{3,}/.test(s) && isWords(s.trim().replace(/^[(·–-]\s*/, '')); // " · invited"
  if (/^https?:|:\/\/|%|yyyy|MMM|HH:mm|^[\w.-]+\.(?:png|svg|ics|json)$|^[a-z][\w.-]*$/.test(s)) return false;
  if (/^[A-Za-z][\w]*(?:[-_./][\w]+)+$/.test(s)) return false; // keys like ai_group, text/plain
  return /^[^a-z]/.test(s) || / /.test(s);
}
const skipLine = (line) => /^\s*(\/\/|\*|\/\*)|\bcase\s+"|"\s*->|\bLog\.|\bprint\(|forKey|UserDefaults|getString\(|putString\(|header\(|import |@\w+\(|systemImage:\s*$/.test(line);

function wrap() {
  let changed = 0;
  for (const file of sources()) {
    const kotlin = file.endsWith('.kt');
    const before = fs.readFileSync(file, 'utf8');
    const lines = before.split('\n').map((line) => {
      if (skipLine(line) || line.includes('"""')) return line;
      return line.replace(LITERAL, (m, s, at, whole) => {
        if (!isWords(s)) return m;
        if (/\btr\(\s*$/.test(whole.slice(0, at))) return m;
        if (/systemImage:\s*$|named:\s*$|forResource:\s*$|key:\s*$/.test(whole.slice(0, at))) return m;
        return `tr(${m})`;
      });
    });
    let after = lines.join('\n');
    if (kotlin && after !== before && !/^import ai\.record\.core\.(tr|\*)$/m.test(after) && !/^package ai\.record\.core$/m.test(after)) {
      after = after.replace(/^(package [^\n]+\n)/m, '$1\nimport ai.record.core.tr\n');
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed++;
    }
  }
  console.log(`${changed} files changed`);
}

/** Every phrase the apps ask for: tr("…") in their code. */
function asked() {
  const set = new Set();
  for (const file of sources()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\btr\(\s*"((?:[^"\\\n]|\\.)*)"/g)) {
      set.add(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
  }
  return [...set].sort();
}

async function tables() {
  const web = {};
  for (const l of LANGS) web[l] = (await import(path.join(ROOT, `public/i18n/${l}.js`))).default;
  const native = JSON.parse(fs.readFileSync(path.join(ROOT, NATIVE), 'utf8'));
  const missing = [];
  const out = Object.fromEntries(LANGS.map((l) => [l, {}]));
  for (const key of asked()) {
    for (const l of LANGS) {
      const v = native[key]?.[l] ?? (typeof web[l][key] === 'string' ? web[l][key] : undefined);
      if (v == null) missing.push(`${l}: ${key}`);
      else out[l][key] = v;
    }
  }
  return { out, missing };
}

const swiftFile = (out) => `// The apps' words in Italian, French, Spanish, Portuguese, German and Polish.
// Made by scripts/native-i18n.mjs build: change scripts/native-phrases.json or
// public/i18n/*.js, then run it again. Don't edit this file by hand.
import Foundation

private let table: [String: [String: String]] = {
    let json = ##"${JSON.stringify(out)}"##
    return (try? JSONDecoder().decode([String: [String: String]].self, from: Data(json.utf8))) ?? [:]
}()

/// The phone's language, when the app has its words; else English.
let appLanguage: String = {
    let code = String((Locale.preferredLanguages.first ?? "en").prefix(2))
    return table[code] == nil ? "en" : code
}()

/// The phrase in the phone's language.
func tr(_ english: String) -> String {
    table[appLanguage]?[english] ?? english
}
`;

const kt = (s) => JSON.stringify(s).replace(/\$/g, '\\$');
const kotlinFile = (out) => `// The apps' words in Italian, French, Spanish, Portuguese, German and Polish.
// Made by scripts/native-i18n.mjs build: change scripts/native-phrases.json or
// public/i18n/*.js, then run it again. Don't edit this file by hand.
package ai.record.core

import java.util.Locale

private val LANGUAGES = setOf("en", ${LANGS.map((l) => `"${l}"`).join(', ')})

/** The phone's language, when the app has its words; else English. Tests may change it. */
var appLanguage: String = Locale.getDefault().language.let { if (it in LANGUAGES) it else "en" }

/** The phrase in the phone's language. */
fun tr(english: String): String = TABLES[appLanguage]?.get(english) ?: english

private val TABLES: Map<String, Map<String, String>> by lazy {
    mapOf(
${LANGS.map((l) => `        "${l}" to ${l}(),`).join('\n')}
    )
}
${LANGS.map((l) => `
private fun ${l}(): Map<String, String> = hashMapOf(
${Object.entries(out[l]).map(([k, v]) => `    ${kt(k)} to ${kt(v)},`).join('\n')}
)
`).join('')}`;

const mode = process.argv[2];
if (mode === 'wrap') wrap();
else {
  const { out, missing } = await tables();
  const swift = swiftFile(out);
  const kotlin = kotlinFile(out);
  if (mode === 'check') {
    const stale = [[SWIFT_OUT, swift], [KOTLIN_OUT, kotlin]].filter(([f, text]) => !fs.existsSync(path.join(ROOT, f)) || fs.readFileSync(path.join(ROOT, f), 'utf8') !== text);
    if (missing.length || stale.length) {
      console.error([...missing.map((m) => `missing ${m}`), ...stale.map(([f]) => `out of date: ${f} (run node scripts/native-i18n.mjs build)`)].join('\n'));
      process.exit(1);
    }
    console.log(`${asked().length} phrases, all in ${LANGS.length} languages`);
  } else {
    if (missing.length) {
      console.error(`${missing.length} translations missing:\n${[...new Set(missing.map((m) => m.slice(4)))].map((k) => JSON.stringify(k)).join('\n')}`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(ROOT, SWIFT_OUT), swift);
    fs.writeFileSync(path.join(ROOT, KOTLIN_OUT), kotlin);
    console.log(`${asked().length} phrases written for iPhone and Android`);
  }
}
