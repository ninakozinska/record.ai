# Your notes in Claude, ChatGPT, Gemini and other AI assistants

record.ai can give an AI assistant your notes as context, so you can ask it
"What's on this week?", "Plan Saturday around the kids' activities", or "Turn
this conversation into notes". It works with any assistant that supports MCP
(the Model Context Protocol), and there is a copy button for those that don't.

## Connect an assistant (two minutes)

1. In record.ai, tap your initials → **🤖 AI assistants**.
2. Pick the assistant. Tick **Can add notes** only if it should also write notes.
3. Tap **Connect**. An address ending in a key (`…/mcp/rai_…`) is shown **once**: copy it.
4. Paste it into the assistant:
   - **Claude** (web, desktop, mobile): Settings → Connectors → Add custom connector → paste the address. Custom connectors depend on the Claude plan.
   - **Claude Code / Claude Desktop config**: `claude mcp add --transport http record https://<your server>/mcp --header "Authorization: Bearer rai_…"`.
   - **ChatGPT**: where the plan offers custom connectors (developer mode), add a connector with the address and no sign-in.
   - **Gemini CLI**: in `~/.gemini/settings.json`:
     ```json
     { "mcpServers": { "record": { "httpUrl": "https://<your server>/mcp", "headers": { "Authorization": "Bearer rai_…" } } } }
     ```
   - **Anything else that speaks MCP**: a server with that address.

The menus of these assistants change often; if a step has moved, look for "connectors", "integrations" or "MCP servers".

## What the assistant can do

| Tool | What it does |
|---|---|
| `today` | What is due today, with times, and what is overdue |
| `list_notes` | Notes most important first, by group, by world (work or family) and by date (today, week, overdue) |
| `search_notes` | Find notes by words in the title, text, group or list items |
| `get_note` | One note in full, with its list |
| `list_groups` | The groups and how many open notes each has |
| `add_note` | Write a note (only with a key that may add notes); record.ai's AI then sorts it |

It sees your own notes and the ones shared with you, never anyone else's.

## Safety

- The key is shown once; record.ai keeps only a fingerprint of it.
- Anyone with the address can read your notes. Keep it private; remove the key under 🤖 AI assistants if it leaks, and it stops working at once.
- Each key shows when it was last used. Make one key per assistant, so you can remove one without the others.
- What the assistant does with your notes is under its own terms (Anthropic, OpenAI, Google…).

## No MCP? Copy and paste

**📋 Copy my notes for an AI chat** (same place) copies your open notes, for the world on screen, as plain text with groups, priorities, dates and list items. Paste it into any chat.

## For developers

`POST /mcp` speaks MCP over Streamable HTTP (one JSON-RPC message per request, JSON answer; protocol versions 2025-06-18, 2025-03-26 and 2024-11-05). Authenticate with `Authorization: Bearer rai_…` or put the key at the end of the path (`/mcp/rai_…`). The code is in `server/assistants.js`, the tests in `test/assistants.test.js`.
