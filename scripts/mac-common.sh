# Shared helpers for the double-click Mac launchers. Sourced, not run.

alert() {
  osascript -e "display alert \"record.ai\" message \"$1\"" >/dev/null 2>&1
}

ask() { # ask "<question>" [hidden] -> prints the answer, fails on Cancel
  local hidden=""
  [ "$2" = "hidden" ] && hidden="with hidden answer"
  osascript -e "text returned of (display dialog \"$1\" default answer \"\" $hidden with title \"record.ai\")" 2>/dev/null
}

setting() { # setting KEY -> value from .env
  [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2-
}

set_setting() { # set_setting KEY VALUE -> replaces or adds the line in .env
  umask 077
  touch .env
  grep -v -E "^$1=" .env > .env.tmp
  printf '%s=%s\n' "$1" "$2" >> .env.tmp
  mv .env.tmp .env
}

choose_ai() { # asks which AI to use and saves it; fails on Cancel
  local choice key
  choice=$(osascript -e 'button returned of (display dialog "Which AI should organize your notes?

• Free on this Mac — private and free. Needs the free Ollama app and a one-time 3 GB download.

• Claude online (cheap) — smarter. Costs a few cents per 100 notes; needs an Anthropic API key with credit.

• No AI — notes are saved but not sorted." buttons {"No AI", "Claude online (cheap)", "Free on this Mac"} default button 3 with title "record.ai")' 2>/dev/null) || return 1
  case "$choice" in
    "Free on this Mac")
      set_setting AI_PROVIDER ollama
      ;;
    "Claude online (cheap)")
      set_setting AI_PROVIDER anthropic
      set_setting CLAUDE_MODEL claude-haiku-5-5
      if [ -z "$(setting ANTHROPIC_API_KEY)" ]; then
        key=$(ask "Paste your Claude API key (from console.anthropic.com):" hidden) || return 1
        set_setting ANTHROPIC_API_KEY "$key"
      fi
      ;;
    *)
      set_setting AI_PROVIDER none
      ;;
  esac
}

start_ollama() { # makes sure the Ollama app is installed and running
  if [ -d /Applications/Ollama.app ]; then
    open -ga Ollama
  elif ! command -v ollama >/dev/null 2>&1; then
    alert "The free AI needs the Ollama app. Its download page will open now: download it, open it once (move it to Applications if asked), then double-click 'Start record.ai' again.

To change your choice instead, double-click 'Change AI'."
    open "https://ollama.com/download"
    exit 1
  fi
}

stop_server() { # stops a running record.ai on port $PORT
  local pids
  pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
  [ -n "$pids" ] && kill $pids && sleep 1
}
