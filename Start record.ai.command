#!/bin/bash
# Double-click this file on a Mac to start record.ai.
# First run: installs what it needs and asks for your password and Claude key.
# Keep the Terminal window open while you use the app; close it to stop.

cd "$(dirname "$0")" || exit 1
PORT=3000

alert() {
  osascript -e "display alert \"record.ai\" message \"$1\"" >/dev/null 2>&1
}

ask() { # ask "<question>" [hidden] -> prints the answer, fails on Cancel
  local hidden=""
  [ "$2" = "hidden" ] && hidden="with hidden answer"
  osascript -e "text returned of (display dialog \"$1\" default answer \"\" $hidden with title \"record.ai\")" 2>/dev/null
}

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

# 3. Settings (first run only; stored in the .env file next to this one)
if [ ! -f .env ]; then
  PASSWORD=$(ask "Choose a password for your notes (you'll type it once on each device):" hidden) || exit 1
  while [ -z "$PASSWORD" ]; do
    PASSWORD=$(ask "The password can't be empty. Choose a password:" hidden) || exit 1
  done
  KEY=$(ask "Paste your Claude API key (from console.anthropic.com). Leave empty to try the app without AI:" hidden) || exit 1
  umask 077
  cat > .env <<EOF
APP_PASSWORD=$PASSWORD
ANTHROPIC_API_KEY=$KEY
# Cheaper model for testing (remove the # to use it):
# CLAUDE_MODEL=claude-haiku-5-5
EOF
  echo "Settings saved to .env (edit it with: open -e .env)"
fi

# 4. Already running?
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "record.ai is already running."
  open "http://localhost:$PORT"
  exit 0
fi

# 5. Phone access over HTTPS via Tailscale, if installed
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

( sleep 2; open "http://localhost:$PORT" ) &
# caffeinate keeps the Mac from idle-sleeping while the server runs,
# so your phone can keep syncing.
exec caffeinate -i npm start
