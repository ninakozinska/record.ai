// Syntax check for the iPhone app's Swift files (no Mac needed).
// It catches typos and unbalanced brackets, not type errors: those need Xcode.
// Usage: npm run check:swift
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('web-tree-sitter');

function swiftFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return swiftFiles(p);
    return e.name.endsWith('.swift') ? [p] : [];
  });
}

await Parser.init();
const Swift = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-swift.wasm'));
const parser = new Parser();
parser.setLanguage(Swift);

const files = process.argv.length > 2 ? process.argv.slice(2) : swiftFiles('ios');
let problems = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const walk = (node) => {
    if (node.type === 'ERROR' || node.isMissing()) {
      problems++;
      const { row, column } = node.startPosition;
      console.error(`${file}:${row + 1}:${column + 1} ${node.isMissing() ? `missing ${node.type}` : 'syntax error'} | ${lines[row].trim()}`);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  };
  walk(parser.parse(src).rootNode);
}
if (problems) {
  console.error(`${problems} problem(s) in ${files.length} Swift file(s)`);
  process.exit(1);
}
console.log(`Swift syntax OK (${files.length} files)`);
