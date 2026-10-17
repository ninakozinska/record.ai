#!/bin/bash
# Double-click this file on a Mac to start record.ai.
# First run: installs what it needs and asks which AI to use.
# Keep the Terminal window open while you use the app; close it to stop.

cd "$(dirname "$0")" || exit 1
PORT=3000
source scripts/mac-common.sh

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  alert "Node.js is needed first. The download page will open: install the LTS version, then double-click this file again."
  open "https://nodejs.org/"
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  alert "Your Node.js ($(node -v)) is too old. Install the current LTS version from nodejs.org, then try again."
  open "https://nodejs.org/"
  exit 1
fi

# 2. Libraries (first run, or after an update changed package.json)
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "Installing (first run only)…"
  npm install --omit=dev --no-audit --no-fund || { alert "Installing failed — see the Terminal window for details."; exit 1; }
  touch node_modules
fi

# 3. Settings (stored in the .env file next to this one).
# Accounts are created in the app itself: the first visit asks you to create yours.
if [ -z "$(setting AI_PROVIDER)" ]; then
  choose_ai || exit 1
fi

# 4. Already running?
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "record.ai is already running."
  open "http://localhost:$PORT"
  exit 0
fi

# 5. Free local AI
if [ "$(setting AI_PROVIDER)" = "ollama" ]; then
  start_ollama
fi

# 6. Phone access over HTTPS via Tailscale, if installed
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -x "$TS" ]; then
  ( sleep 3
    "$TS" serve --bg $PORT >/dev/null 2>&1 || "$TS" serve --bg $PORT
    URL=$("$TS" serve status 2>/dev/null | grep -Eo 'https://[^ ]+' | head -1)
    [ -n "$URL" ] && printf '\n📱 On your phone (with Tailscale on), open:  %s\n\n' "$URL"
  ) &
fi

LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "💻 On this Mac:  http://localhost:$PORT"
[ -n "$LAN" ] && echo "   Same Wi-Fi (typing only, no camera/mic):  http://$LAN:$PORT"
echo "   Close this window to stop record.ai."
echo

# Open the browser once the server answers (the first local-AI download can take a while).
( for _ in $(seq 1 900); do
    curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1 && { open "http://localhost:$PORT"; break; }
    sleep 2
  done ) &
# caffeinate keeps the Mac from idle-sleeping while the server runs,
# so your phone can keep syncing.
exec caffeinate -i npm start
