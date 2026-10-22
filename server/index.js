import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { ensureOllamaModel } from './ollama.js';
import { configuredProviders } from './oauth.js';
import { importArchive } from './import.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const local = (process.env.AI_PROVIDER || '').toLowerCase() === 'ollama';

// With the local AI, get the model ready before notes are sent to it.
if (local) await ensureOllamaModel();

fs.mkdirSync(dataDir, { recursive: true });
importArchive(dataDir);

const { app, organizer, store } = createApp({ dataDir });

app.listen(port, () => {
  console.log(`record.ai listening on http://localhost:${port}`);
  console.log(`data directory: ${dataDir}`);
  const ai = organizer.status;
  console.log(ai.enabled ? `AI: ${ai.provider === 'ollama' ? 'free local AI' : 'Claude'} (${ai.model})` : 'AI: off');
  const signin = configuredProviders().map((p) => p.name);
  console.log(`Sign-in with: email${signin.length ? ', ' + signin.join(', ') : ' (see docs/SOCIAL_LOGIN.md to add Google, Apple, …)'}`);
  if (signin.length && !process.env.PUBLIC_URL) console.log('Tip: set PUBLIC_URL to the address people use, so Google & co. send them back to the right place.');
  if (store.userCount() === 0) console.log('No account yet: open the app and create yours (the first account owns this server).');
  if (!organizer.enabled) console.warn('WARNING: no AI configured — notes will be saved but not organized.');
});
