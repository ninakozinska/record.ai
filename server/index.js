import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { ensureOllamaModel } from './ollama.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const local = (process.env.AI_PROVIDER || '').toLowerCase() === 'ollama';

// With the local AI, get the model ready before notes are sent to it.
if (local) await ensureOllamaModel();

const { app, organizer } = createApp({ dataDir });

app.listen(port, () => {
  console.log(`record.ai listening on http://localhost:${port}`);
  console.log(`data directory: ${dataDir}`);
  const ai = organizer.status;
  console.log(ai.enabled ? `AI: ${ai.provider === 'ollama' ? 'free local AI' : 'Claude'} (${ai.model})` : 'AI: off');
  if (!process.env.APP_PASSWORD) console.warn('WARNING: APP_PASSWORD is not set — anyone who can reach this server can read your notes.');
  if (!organizer.enabled) console.warn('WARNING: no AI configured — notes will be saved but not organized.');
});
