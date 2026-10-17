// Startup helper for the free local AI: make sure Ollama is reachable and the
// model is downloaded (first run downloads a few GB, with progress shown).
import { ollamaModel, ollamaUrl } from './organizer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable() {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Resolves true when the model is ready to use. Never throws. */
export async function ensureOllamaModel({ log = console, waitSeconds = 30 } = {}) {
  const model = ollamaModel();
  let tags = await reachable();
  for (let i = 0; !tags && i < waitSeconds; i++) {
    if (i === 0) log.log('Waiting for the local AI (Ollama) to start…');
    await sleep(1000);
    tags = await reachable();
  }
  if (!tags) {
    log.warn('WARNING: the local AI (Ollama) is not running. Open the Ollama app, then restart record.ai.');
    return false;
  }
  const have = (tags.models || []).some((m) => m.name === model || m.model === model || m.name === `${model}:latest`);
  if (have) {
    log.log(`Local AI ready: ${model}`);
    return true;
  }

  log.log(`Downloading the local AI model "${model}" (first time only, a few GB — please wait)…`);
  try {
    const res = await fetch(`${ollamaUrl()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, name: model, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    let buf = '';
    let lastPct = -1;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.total && msg.completed) {
          const pct = Math.floor((msg.completed / msg.total) * 100);
          if (pct >= lastPct + 10 || pct === 100) {
            lastPct = pct;
            log.log(`  ${pct}% of ${(msg.total / 1e9).toFixed(1)} GB`);
          }
        }
        if (msg.status === 'success') {
          log.log(`Local AI ready: ${model}`);
          return true;
        }
      }
    }
    throw new Error('download ended unexpectedly');
  } catch (err) {
    log.warn(`WARNING: could not download the local AI model (${err.message}). Check your internet connection and restart record.ai.`);
    return false;
  }
}
