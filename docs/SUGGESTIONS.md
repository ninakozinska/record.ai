# Suggested to-dos

The AI proposes; the person decides. Suggestions wait in the **Suggested** inbox
until they are added (they become a normal note) or dismissed. Nothing becomes a
note on its own. The plan this follows is the Claude doc
"SortNotes: connectors and AI-suggested to-dos (plan)".

## Where suggestions come from

| Source | When | Plan |
|---|---|---|
| Meetings in connected calendars (the next 7 days) and open notes | Every morning at the person's time (07:00 by default), and with **✨ Suggest now** (once an hour) | Free 3 a day, Premium 5 |
| An AI assistant: "send the to-dos from this chat to SortNotes" | When asked, through the `suggest_todos` tool (docs/AI_ASSISTANTS.md) | Premium, with a key that may add notes |
| A chat export from ChatGPT or Claude (JSON or text) | **💬 To-dos from an AI chat export** in the inbox | Premium |

Next, in later pull requests: Google Docs and Drive, Word and OneDrive, Notion,
and forwarded emails.

## What happens

1. The server gathers the meetings, the open notes (titles and dates, so nothing
   is suggested twice) and the last ten dismissed suggestions.
2. Claude Haiku answers in a fixed shape: title, date, time, priority, reason,
   source, and one "top to-do of the day".
3. The server checks every answer: real dates only, no duplicates of open notes
   or of anything added or dismissed before, at most the plan's number a day.
4. The top one appears on the morning card above the Today line, and as a
   notification if notifications are on. The rest are in the inbox.
5. Add, Edit and add, Dismiss. Open suggestions fade out after three days; one
   from a meeting that is no longer in the calendar goes at once.

Suggestions do not count against the 300 monthly AI sortings. A daily run costs
about $0.0006, roughly 2 cents per active person a month.

## Privacy

The AI sees the meetings' titles, times and descriptions, the titles of open
notes and the chat text the person chose to send, never their name or email.
A chat export is read once and not kept; SortNotes keeps only the suggestions.
Deleting the account deletes every suggestion.

## Settings

In the account menu, **✨ Suggested to-dos**: on or off, and the time.
