#!/bin/bash
# Double-click to choose which AI organizes your notes (free on this Mac,
# Claude online, or none). Restarts record.ai with the new choice.

cd "$(dirname "$0")" || exit 1
PORT=3000
source scripts/mac-common.sh

choose_ai || exit 0
echo "Saved. Restarting record.ai…"
stop_server
exec "./Start record.ai.command"
