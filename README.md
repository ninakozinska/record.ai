# record.ai

Notes you **type, dictate, or photograph**. They sync across your phone, your computer, and the web, and **Claude organizes them for you**: it gives each note a title, a priority (urgent, high, normal, low), a topic group, tags and a due date.

<p>
  <img src="docs/screenshot-desktop.png" width="560" alt="Desktop: notes sorted by priority">
  <img src="docs/screenshot-phone.png" width="200" alt="Phone: note editor">
</p>

## What it does

- **Write** notes, or **dictate** them with 🎤 (speech-to-text in the browser).
- **Photos**: pick images 🖼️, paste or drag them in, or take pictures with the **camera** 📷. Claude looks at the photos too (receipts, whiteboards, documents).
- **Automatic organization**: each new or edited note is sent to Claude, which assigns a title, summary, **priority**, **group**, tags and a due date. It reuses your existing groups so the list stays tidy.
- **✨ Reorganize**: Claude reviews all open notes together, merges similar groups and re-ranks priorities against today's date. This also runs on its own after every 20 newly organized notes.
- **Two views**: *Priority* (Urgent → Low) and *Groups*. There's also search, group filter chips, and a "done" checkbox.
- **Your choices win**: open a note to set its group or priority yourself (📌). The AI won't change it until you set it back to *Auto*.
- **Same notes on every device**: changes show up live on your other devices.
- **Works offline**: notes and photos are saved on the device first and upload when you're back online.
- **Installable** on iPhone, Android, Windows, macOS, Linux and ChromeOS. It's one app (a Progressive Web App), so there are no app stores to deal with.

## Run it locally

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # then edit: APP_PASSWORD and ANTHROPIC_API_KEY
npm start                 # → http://localhost:3000
```

Get an API key at <https://console.anthropic.com/>. Without a key the app still works and syncs, but notes go into "Inbox" with a basic title and aren't organized.

## Put it online (so your phone can reach it)

Your devices all talk to one small server that stores the notes. Camera, microphone and "install app" only work over **HTTPS**, so host it somewhere that gives you HTTPS:

- **Render (easiest)**: push this repo to GitHub, then on render.com choose **New → Blueprint** and pick the repo. `render.yaml` sets up the server and a persistent disk. Enter `APP_PASSWORD` and `ANTHROPIC_API_KEY` when it asks.
- **Any Docker host** (Fly.io, Railway, a VPS…):
  ```bash
  docker build -t record-ai .
  docker run -p 3000:3000 -v record-ai-data:/data \
    -e APP_PASSWORD=... -e ANTHROPIC_API_KEY=... record-ai
  ```
  Put HTTPS in front of it (most hosts do this for you, or use Caddy or a Cloudflare Tunnel).
- **Home computer only**: `npm start`, then reach it over HTTPS with [Tailscale](https://tailscale.com/kb/1312/serve) (`tailscale serve 3000`) or a Cloudflare Tunnel.

**Always set `APP_PASSWORD`** on a public server. Otherwise anyone with the URL can read your notes.

## Install it on your devices

Open your server's URL, enter the password, then:

| Device | How |
|---|---|
| iPhone / iPad | Safari → Share → **Add to Home Screen** |
| Android | Chrome → ⋮ → **Install app**. Afterwards you can share text from other apps straight into record.ai. |
| Windows / macOS / Linux | Chrome or Edge → install icon in the address bar (or ⋮ → **Install record.ai**) |
| Any browser | Just use the website |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | *(none)* | Password to unlock the app. Required for any server others can reach. |
| `ANTHROPIC_API_KEY` | *(none)* | Turns on AI organization. |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model to use. |
| `REORGANIZE_EVERY` | `20` | Run a full reorganize after this many newly organized notes. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where the SQLite database and photos are stored. **Back this up.** |

## How it works

```
 phone ─┐                      ┌─ SQLite (notes)
 laptop ┼─ HTTPS ─ Node server ┼─ data/images (photos)
 web ───┘   ▲  live updates    └─ Claude API (organize)
            └─ (Server-Sent Events)
```

- `public/`: the app (plain HTML/CSS/JS, no build step). `local.js` stores notes in IndexedDB, queues changes in an outbox, and syncs. `sw.js` lets the app open offline.
- `server/`: Express API. `db.js` is storage (Node's built-in SQLite). `organizer.js` holds the Claude prompts. It uses structured outputs, so replies always match the schema, and server-side refusal fallback.
- Sync: every change gets an increasing revision number. Devices fetch "everything since revision N" and get live pushes. If two devices edit the same note, the most recent edit wins. The AI writes only its own fields (title, AI group and priority…), so it never overwrites your text or your choices.

## Development

```bash
npm run dev     # restart on changes
npm test        # API tests (Claude is faked)
npm run e2e     # browser test: two devices, photos, camera, offline sync
```

## Known limitations

- **Dictation** uses the browser's speech recognition: Chrome, Edge, Safari (including iPhone) and Android. Firefox doesn't support it, so use your keyboard's 🎤 key instead.
- It's built for **one person** (one password, one shared notebook). It doesn't have separate user accounts.
- Photos are shrunk to 1600px before upload to keep sync and AI calls fast.
