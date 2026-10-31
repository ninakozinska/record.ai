// Makes the demo account that Apple's and Google's reviewers log in with,
// with Premium and a few example notes (no AI calls). Running it again
// resets the password and the example notes.
// Usage, on the server:  fly ssh console -C "node scripts/demo-account.mjs review@your-domain 'a long password'"
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { hashPassword, MIN_PASSWORD } from '../server/auth.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/demo-account.mjs review@your-domain "a long password"');
  process.exit(1);
}
if (password.length < MIN_PASSWORD) {
  console.error(`The password needs at least ${MIN_PASSWORD} characters.`);
  process.exit(1);
}
const store = openDb(path.resolve(process.env.DATA_DIR || 'data'));
// The first account owns the server and everything on it: never the demo one.
if (store.userCount() === 0) {
  console.error('Create your own account first: the first account on a server owns it.');
  process.exit(1);
}
let user = store.findUserByEmail(email);
if (!user) user = store.createUser({ email, name: 'App Review', pwHash: await hashPassword(password) });
else store.setPassword(user.id, await hashPassword(password));
store.setPlan(user.id, 'family');

// Fresh example notes: dates from today, as the AI would have sorted them.
for (const n of store.changesSince(user.id, 0, { items: true })) {
  if (!n.deleted) store.upsertFromClient(user.id, { id: n.id, deleted: true, edited_at: Date.now() });
}
const day = (plus) => new Date(Date.now() + plus * 864e5).toISOString().slice(0, 10);
const add = (text, ai, items = []) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  store.upsertFromClient(user.id, { id, text, created_at: now, edited_at: now });
  store.applyAi(id, { status: 'done', tags: [], summary: null, ...ai });
  for (const item of items) store.upsertFromClient(user.id, { id: crypto.randomUUID(), parent_id: id, text: item, created_at: now, edited_at: now + 1 });
};
add('Send the quarterly report tomorrow morning', { title: 'Send the quarterly report', group: 'Work', priority: 'urgent', due_date: day(1), due_time: '09:00', priority_reason: 'A deadline tomorrow' });
add('Dentist for Mia on Thursday at 15:30', { title: 'Dentist for Mia', group: 'Kids', priority: 'high', due_date: day(3), due_time: '15:30' });
add('Groceries', { title: 'Groceries', group: 'Home', priority: 'normal' }, ['Milk', 'Eggs', 'Bread for the school trip', 'Apples']);
add('Sign the school trip form', { title: 'Sign the school trip form', group: 'Kids', priority: 'high', due_date: day(2) });
add('Idea: a weekend in the mountains in spring', { title: 'Weekend in the mountains', group: 'Ideas', priority: 'low' });
console.log(`Demo account ready: ${user.email}, Family plan, 5 example notes.`);
