// Moving your notes to a new server (for example from your Mac to Fly.io):
// put a tar.gz of your data folder at <DATA_DIR>/import.tar.gz and restart.
// On start, it replaces this server's notes and photos with the archive's.
// See docs/DEPLOY_FLY.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const IMPORT_FILE = 'import.tar.gz';

/** Unpacks <dataDir>/import.tar.gz if present. Returns true when it did. */
export function importArchive(dataDir, log = console) {
  const archive = path.join(dataDir, IMPORT_FILE);
  if (!fs.existsSync(archive)) return false;
  // The archive brings its own database; a leftover journal from the old one would corrupt it.
  for (const f of ['notes.db', 'notes.db-wal', 'notes.db-shm']) fs.rmSync(path.join(dataDir, f), { force: true });
  execFileSync('tar', ['-xzf', archive, '-C', dataDir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.rmSync(archive);
  log.log(`Imported notes and photos from ${IMPORT_FILE}.`);
  return true;
}
