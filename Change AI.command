#!/bin/bash
# Double-click to choose which AI organizes your notes (free on this Mac,
# Claude online, or none). Restarts record.ai with the new choice.

cd "$(dirname "$0")" || exit 1
source scripts/mac-common.sh
# The port: from the environment, else from .env, else 3000.
PORT=${PORT:-$(setting PORT)}
PORT=${PORT:-3000}
export PORT

choose_ai || exit 0
echo "Saved. Restarting record.ai…"
stop_server
exec "./Start record.ai.command"
