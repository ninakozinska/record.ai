// Sets a new password for an account (there is no email to send reset links).
// Usage: npm run reset-password -- you@example.com "new password"
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { hashPassword, MIN_PASSWORD } from '../server/auth.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: npm run reset-password -- you@example.com "new password"');
  process.exit(1);
}
if (password.length < MIN_PASSWORD) {
  console.error(`The password needs at least ${MIN_PASSWORD} characters.`);
  process.exit(1);
}
const store = openDb(path.resolve(process.env.DATA_DIR || 'data'));
const user = store.findUserByEmail(email);
if (!user) {
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
store.setPassword(user.id, await hashPassword(password));
store.deleteUserSessions(user.id);
console.log(`Password changed for ${user.email}. All devices must log in again.`);
