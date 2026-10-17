# record.ai server API

The web app (`public/`) and the iPhone app (`ios/`) use this HTTP API. All bodies are JSON unless noted. Times are milliseconds since 1970.

## Authentication

Log in or sign up to get a **session token**. The web app receives it as an `HttpOnly` cookie (`notes_session`). Other apps send it as a header:

```
Authorization: Bearer <token>
```

Sessions expire after 400 days without use. The server stores only a SHA-256 hash of each token. Every endpoint except `/api/health` and `/api/auth/state|signup|login|logout` answers `401 {"error":"Login required","loginRequired":true}` without a valid session.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/health` | | `{"ok":true,"app":"record.ai"}` |
| GET | `/api/auth/state` | | `{"user": {id,name,email} \| null, "signup": {"open","needsCode","firstAccount"}}` |
| POST | `/api/auth/signup` | `{name, email, password, code?}` | `{token, user}`; 400 invalid input, 403 sign-up closed or wrong invite code, 409 email taken |
| POST | `/api/auth/login` | `{email, password}` | `{token, user}`; 401 wrong email or password; 429 after 10 failures in 15 minutes (per IP and per email) |
| POST | `/api/auth/logout` | | `{"ok":true}`; ends this session |
| GET | `/api/auth/me` | | `{user, devices}`: devices = number of active sessions |
| POST | `/api/auth/logout-others` | | `{"ok":true, devices}`: ends every other session |
| POST | `/api/auth/password` | `{current, next}` | `{"ok":true}`; 403 wrong current password; ends every other session |

**Who may sign up:** the first account always can. It becomes the owner and takes over notes and photos created before accounts existed. After that, sign-up needs `ALLOW_SIGNUP=true`, or the invite code set in `SIGNUP_CODE`. Passwords need at least 8 characters and are stored as scrypt hashes.

## Notes

A note as the server sends it:

```json
{
  "id": "5f0c…", "text": "Pay the electricity bill", "images": ["ab12….jpg"],
  "done": false, "deleted": false, "created_at": 1792230000000, "edited_at": 1792230000000,
  "user_group": null, "user_priority": "high",
  "title": "Pay electricity bill", "summary": "…", "ai_group": "Home", "ai_priority": "urgent",
  "priority_reason": "due tomorrow", "tags": ["bills"], "due_date": "2026-10-18",
  "ai_status": "done", "ai_error": null,
  "group": "Home", "priority": "high", "rev": 42, "user_id": "…"
}
```

- `user_group` / `user_priority` are the person's own choices. `null` means "let the AI decide". `group` / `priority` are the effective values: the person's choice if set, otherwise the AI's.
- `ai_status` is one of `pending`, `done`, `error` (see `ai_error`), or `off` (no AI configured).
- `rev` increases with every change on the server. Clients must ignore a note whose `rev` is lower than the copy they already have, because replies and live updates can arrive out of order.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/notes?since=<rev>` | | `{rev, notes}`: your notes changed after `rev` (deleted ones too) |
| PUT | `/api/notes/:id` | any of `text, images, done, deleted, user_group, user_priority, created_at` + **`edited_at` (required)** | `{note, stale}`. `stale: true` = a newer edit already exists and yours was ignored; 403 = the id belongs to someone else |
| POST | `/api/notes/:id/reanalyze` | | `{"ok":true}`: queues the AI again |
| POST | `/api/reorganize` | | `{updated}` or `{skipped:true}`: the AI re-groups and re-ranks all your open notes |
| GET | `/api/status` | | `{ai: {enabled, provider, model, pending, reorganizing}, rev, groups: [{name,count}]}` |
| GET | `/api/server-info` | | `{port, addresses: ["http://192.168.1.20:3000", …]}`: where other devices on the network can reach this server |

- **Note ids** are chosen by the client (a UUID), so notes can be created offline. Allowed: 8 to 64 letters, digits or `-`.
- **Conflicts:** the last edit wins, by `edited_at`. An old offline edit cannot overwrite a newer one.
- **AI:** changing `text` or `images` sets `ai_status` to `pending` and queues the note. Changing only the other fields does not.

## Photos

| Method | Path | Body | Answer |
|---|---|---|---|
| PUT | `/api/images/:name` | the raw image bytes (any `Content-Type` except JSON) | `{"ok":true}`; 403 if the name belongs to someone else |
| GET | `/api/images/:name` | | the image; 404 if it isn't yours |

`name` = 8 to 64 letters, digits or `-`, then `.jpg`, `.jpeg`, `.png`, `.webp` or `.gif`. The maximum size is 15 MB. Upload a photo before (or soon after) saving the note that lists it in `images`. If the note was analysed before its photo arrived, the upload queues it again.

## Live updates

`GET /api/events` is a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream for the logged-in user. Each message is an `event:` line followed by one `data:` line of JSON:

| event | data | when |
|---|---|---|
| `hello` | `{rev, ai}` | right after connecting: pull `/api/notes?since=` to catch up |
| `note` | a note | any of your notes changed (yours, another device's, or the AI's) |
| `status` | the `ai` status | a reorganize started or finished |

A comment line `: ping` arrives every 25 seconds to keep the connection open.
