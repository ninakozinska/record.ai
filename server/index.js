import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const { app, organizer } = createApp({ dataDir });

app.listen(port, () => {
  console.log(`record.ai listening on http://localhost:${port}`);
  console.log(`data directory: ${dataDir}`);
  if (!process.env.APP_PASSWORD) console.warn('WARNING: APP_PASSWORD is not set — anyone who can reach this server can read your notes.');
  if (!organizer.enabled) console.warn('WARNING: ANTHROPIC_API_KEY is not set — notes will not be organized by AI.');
});
