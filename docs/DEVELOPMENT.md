# Developing record.ai

## How the parts fit

```
 web app (public/)  ─┐                        ┌─ SQLite: data/notes.db (users, sessions, notes)
 iPhone app (ios/)  ─┤
 Android (android/) ─┼─ HTTP + live updates ─ server/ ─┼─ data/images/ (photos)
 other browsers     ─┘     (cookie or token)          └─ AI: Claude API or Ollama
```

| File | What it does |
|---|---|
| `server/index.js` | Starts the server, loads `.env`, gets the local AI model ready |
| `server/app.js` | HTTP routes for notes, photos, live updates; serves the web app |
| `server/auth.js` | Accounts: sign-up rules, login throttling, sessions, password hashing |
| `server/import.js` | Moving notes to a new server: unpacks `DATA_DIR/import.tar.gz` on start ([DEPLOY_FLY.md](DEPLOY_FLY.md)) |
| `fly.toml`, `Dockerfile` | Running online on Fly.io |
| `server/oauth.js` | "Continue with Google / Apple / Microsoft / Facebook / LinkedIn / X / GitHub" ([SOCIAL_LOGIN.md](SOCIAL_LOGIN.md)) |
| `server/db.js` | All storage, plus upgrades of older databases |
| `server/organizer.js` | Prompts, Claude/Ollama calls, the per-user queue, reorganizing, plain-language errors |
| `server/ollama.js` | Checks Ollama is running and downloads the model on first start |
| `public/local.js` | Web client storage (IndexedDB), outbox and sync |
| `public/app.js` | Web UI: composer, dictation, camera, lists, editor, login, account |
| `public/sw.js` | Service worker: the app opens offline; photos are cached |
| `ios/RecordAI.swiftpm` | Native iPhone app (SwiftUI); see `ios/README.md` |
| `android/core` | Android sync engine in plain Kotlin (API client, outbox, merge rules, live updates). No Android code, so it is tested on any computer |
| `android/app` | Native Android app (Jetpack Compose) on top of `core`; see `android/README.md` |
| `Start record.ai.command`, `Change AI.command`, `scripts/mac-common.sh` | Double-click launchers for the Mac |
| `scripts/reset-password.mjs` | Sets a new password (`npm run reset-password -- email "password"`) |

The API is described in [API.md](API.md).

## Sync rules

The web, iPhone and Android clients follow the same rules:

1. **Local first.** An edit is saved on the device and added to an **outbox**. The outbox is sent when online; nothing is lost offline.
2. **One outbox entry per note.** Edits made before sending are merged into one request.
3. **Edits made while sending** are sent right after the current round, not on the next timer.
4. **Last edit wins** on the server, by `edited_at`.
5. **Unsent edits stay** when server updates arrive. Only the AI's fields (title, summary, AI group and priority, tags, due date, status) are taken from the server.
6. **Never go backwards.** A server note with a lower `rev` than the device's copy is ignored. This prevents a slow reply from overwriting a newer live update.
7. If the server's revision counter is lower than the device's, the server's database was replaced: the device drops its cached notes and loads everything again.
8. **One request per sync.** Photos are uploaded first (preview, then full size), then every outbox entry goes in one `POST /api/sync`, which also returns what changed on the server.
9. **Small first.** Lists show 320px previews; the full photo loads only when opened. Images are cached in memory and on the device.
10. **Live, not polling.** While the app is open, changes arrive over `/api/events`. A phone app closes this connection when it goes to the background (saving battery) and catches up with one sync when it comes back. Unsent edits are sent before the app is suspended (iPhone: background task; Android: WorkManager when the network returns).
11. **Lists are opt-in.** An app that shows lists asks for items (`items=1` / `items: true`); older apps never receive them, so they don't show items as loose notes.
12. **Logging out removes** the account's notes, photos and outbox from the device.

## Tests

```bash
npm test               # server, accounts, AI, scripts, iPhone protocol (Claude and Ollama are faked)
npm run e2e            # real Chromium: desktop + phone, sign-up, sync, photos, camera, offline, logout, Continue with Google
npm run check:swift    # syntax check of the iPhone app (no Mac needed)
cd android && ./gradlew :core:test   # Android sync engine against the real server (needs Java 17)
npm run coverage       # npm test with a line/branch coverage table
```

| Test file | Covers |
|---|---|
| `test/api.test.js` | Sync by revision, conflicts, AI results applied, user overrides, reorganize |
| `test/auth.test.js` | Sign-up rules, invite codes, login, throttling, logout, password change, users isolated from each other, upgrade from the old database, hashed storage |
| `test/validation.test.js` | Malformed input refused, status and server info, session expiry |
| `test/organizer.test.js` | Claude request options, refusal fallback, no-credit errors, Haiku, refusals and cut-offs, per-user groups and reorganizing, Ollama errors |
| `test/local-ai.test.js` | Ollama: requests, photos, bad answers, model download, not running |
| `test/oauth.test.js` | Sign in with each kind of provider (faked): new accounts, matching verified emails only, sign-up rules, the phone apps' one-time code, connect and disconnect, Apple's signed secret |
| `android/core/…/SocialLoginTest.kt` | The Android app's "Continue with Google" against the real server with a fake Google (`test/fixtures/fake-google-server.mjs`) |
| `test/deploy.test.js` | Online hosting: visitors told apart behind the proxy, notes moved with `import.tar.gz` |
| `test/ios-contract.test.js` | The exact requests the iPhone app makes |
| `test/scripts.test.js` | Password reset; the Mac launchers, run with stand-ins for macOS commands |
| `android/core/src/test/…/SyncRulesTest.kt` | Android merge rules: never go backwards, unsent edits kept while AI results are taken, sorting, groups, server addresses |
| `android/core/src/test/…/ServerIntegrationTest.kt` | Android sync engine against a real server: sign-up, notes and photos synced both ways, offline edits sent later, logout |
| `test/e2e.mjs` | The whole web app in a real browser, on two devices. On failure it saves `data-e2e/FAILED-*.png` |

GitHub runs all of these on every push (`.github/workflows/test.yml`). It also **compiles the Android app** (and keeps the APK as a download on the run's page) and **compiles the iPhone app** for the simulator on a Mac.

**Not covered automatically:**
- The iPhone and Android apps are compiled on GitHub, but their screens are not tested automatically. Try them on a real phone.
- No test calls the real Claude API or a real Ollama install; both are replaced by stand-ins that follow their documented formats.
- No test signs in with a real Google, Apple, Microsoft, Facebook, LinkedIn, X or GitHub account. Their answers are faked from their documentation; try each one once after setting it up.
- The Mac launchers are tested on Linux with stand-ins for `osascript`, `open`, `caffeinate` and `lsof`, not on a real Mac.

## Conventions

- **No build step.** The web app is plain HTML, CSS and JavaScript modules.
- **Server dependencies:** Express, the Anthropic SDK and Zod. Storage uses Node's built-in `node:sqlite`, so there is nothing native to compile.
- **Node.js 22.13 or newer.**
- Every user-facing error explains what to do next (see `friendlyError` in `server/organizer.js`).
