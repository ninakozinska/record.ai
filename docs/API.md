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
| POST | `/api/auth/forgot` | `{email}` | `{"ok":true}` whether or not the account exists. Emails a link `<server>/#reset=<code>`, valid one hour. At most 5 a hour per address and per IP |
| POST | `/api/auth/reset` | `{token, password}` | `{token, user}` (logged in, like log in); ends every other session. 400 = expired or used link |

**Who may sign up:** the first account always can. It becomes the owner and takes over notes and photos created before accounts existed. After that, sign-up needs `ALLOW_SIGNUP=true`, or the invite code set in `SIGNUP_CODE`. Passwords need at least 8 characters and are stored as scrypt hashes.

## Sign in with Google, Apple, …

| Method | Path | Answer |
|---|---|---|
| GET | `/api/auth/state` | also lists `providers: [{id, name}]`, the "Continue with …" options set up on this server |
| GET | `/api/auth/oauth/:provider/start` | redirects to the provider. Query: `invite` (invite code for a new account), `link=1` (add to the logged-in account), `app=<challenge>` (phone apps, see below) |
| GET or POST | `/api/auth/oauth/:provider/callback` | where the provider sends people back. Web: logs in (cookie) and redirects to `/`, `/?login_error=…` or `/?linked=<provider>` |
| POST | `/api/auth/oauth/exchange` | `{code, verifier}` → `{token, user}` (phone apps) |
| GET | `/api/auth/me` | also `hasPassword` and `identities: [{provider, name, email}]` |
| DELETE | `/api/auth/identities/:provider` | disconnects one; 409 if it is the last way to log in |

`provider` is `google`, `apple`, `microsoft`, `facebook`, `linkedin`, `x` or `github`.

**Phone apps:**
1. The app makes a random secret (`verifier`, 43 characters) and keeps it on the phone.
2. It opens `start?app=<challenge>` in the browser, where `challenge` = base64url(SHA-256(verifier)).
3. After sign-in, the server's page opens `recordai://auth?code=…`, or `recordai://auth?error=…`.
4. The app sends `{code, verifier}` to `/exchange` within 2 minutes. The code works once, and only with the matching secret.

POST `/api/auth/password` accepts no `current` when the account has no password yet (made with a provider).

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
- `ai_status` is one of `pending`, `done`, `error` (see `ai_error`), `off` (no AI configured), or `limit` (this month's AI uses are used up; `ai_error` says when it starts again).
- **Dates:** `due_date` (`YYYY-MM-DD`) and `due_time` (`HH:MM` or `null`) are the effective date and time. `user_due` is the person's choice: `null` = let the AI decide (`ai_due_date` / `ai_due_time`), `''` = no date, `'YYYY-MM-DD'` or `'YYYY-MM-DDTHH:MM'`. The AI counts relative dates ("next Tuesday") from the day the note was written.
- `parent_id` is `null` for a note. A **list item** is a note with `parent_id` set to its list's id. Items go one level deep, skip the AI (`ai_status` is `done`), take their priority from `user_priority`, and are deleted with their list. Their parent can't change after creation.
- `rev` increases with every change on the server. Clients must ignore a note whose `rev` is lower than the copy they already have, because replies and live updates can arrive out of order.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/notes?since=<rev>[&items=1]` | | `{rev, notes}`: your notes changed after `rev` (deleted ones too). List items are included only with `items=1` |
| POST | `/api/sync` | `{since, items, changes: [{id, …same fields as PUT}]}` (at most 500; `items: true` to also receive list items) | `{rev, results: [{id, status}], notes}`: sends every waiting edit **and** catches up in one request. `status` is `ok`, `stale`, `forbidden` or `invalid`; `notes` = everything changed after `since`, including the results of your own edits |
| PUT | `/api/notes/:id` | any of `text, images, done, deleted, user_group, user_priority, user_due, created_at, parent_id` + **`edited_at` (required)** | `{note, stale}`. `stale: true` = a newer edit already exists and yours was ignored; 403 = the id belongs to someone else |
| POST | `/api/notes/:id/reanalyze` | | `{"ok":true}`: queues the AI again |
| POST | `/api/reorganize` | | `{updated}` or `{skipped:true}`: the AI re-groups and re-ranks all your open notes. 429 when this month's AI uses are used up |
| GET | `/api/status` | | `{ai: {enabled, provider, model, pending, reorganizing, usage: {used, limit, resets}}, rev, groups: [{name,count}]}`. `usage` is your AI use this month; `limit: null` = no limit |
| GET / PUT | `/api/groups/mine` | `{names}` (PUT: up to 30 names of 1–40 characters) | "My groups": groups the person made. They always show, and the AI files matching notes into them and never renames or merges them. Also in `/api/status` as `myGroups` |
| GET / PUT | `/api/groups/worlds` | `{chosen: {"<group in lowercase>": "work" \| "family" \| ""}}`: groups moved between Work and Family | ("" = both); others are guessed from the name (public/worlds.js) |
| GET | `/api/server-info` | | `{port, addresses: ["http://192.168.1.20:3000", …]}`: where other devices on the network can reach this server |

- **Use `/api/sync`** for normal syncing. The web, iPhone and Android apps send all waiting edits in one `POST /api/sync`, so a phone that was offline catches up with one round trip instead of one per note. `PUT /api/notes/:id` stays for single edits.
- **Note ids** are chosen by the client (a UUID), so notes can be created offline. Allowed: 8 to 64 letters, digits or `-`.
- **Conflicts:** the last edit wins, by `edited_at`. An old offline edit cannot overwrite a newer one.
- **AI:** changing `text` or `images` sets `ai_status` to `pending` and queues the note. Changing only the other fields does not.

## Sharing

A note (with its list items) or a whole group can be shared with other people by email. People it's shared with can **edit** (the text, photos, done, and the list's items) or only **view**. The owner's groups and priorities stay the owner's, and only the owner deletes the note. A shared group covers every note in it, including notes that move into it later. When a note moves out of the group, it is removed from the person's devices.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/shares` | | `{mine: [{id, kind, target, email, name, role, user_id}], withMe: [{id, kind, target, role, owner: {id, name, email}}]}`. `name`/`user_id` are `null` until that email has an account |
| POST | `/api/shares` | `{kind: 'note' \| 'group', target: <note id or group name>, email, role: 'edit' \| 'view'}` (role defaults to `edit`) | `{share, hasAccount}`. Sharing the same thing with the same email again changes the role. Group names match whatever the case. An email without an account gets it as soon as it signs up |
| PATCH | `/api/shares/:id` | `{role}` | `{share}` (owner only) |
| DELETE | `/api/shares/:id` | | `{ok: true}`: the owner stops sharing, or the person leaves |

- Apps receive notes shared with them only when they ask: `shared=1` on `GET /api/notes` and `/api/events`, `shared: true` in `POST /api/sync`. Such a note has `role` (`edit` or `view`) and `owner_name`; its `user_id` is the owner's.
- When someone can no longer see a note, their next sync (and live updates) carries `{id, parent_id, user_id, rev, edited_at, deleted: true, revoked: true}`, without the contents. Remove it from the device.
- A new list item added by an editor belongs to the list's owner.
- `event: shares` on `/api/events` means "reload `/api/shares`".
- Photos in a shared note can be opened by the people it's shared with.

## Calendar

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/notes/:id/calendar.ics` | | One note with a date as a calendar file (all day, or one hour from its time; the device's time zone) |
| GET | `/api/calendar-link?tz=Europe/Rome` | | `{url, webcal}`: your private calendar link, made the first time. `tz` (optional) is the time zone for times in it |
| POST | `/api/calendar-link/reset` | | `{url, webcal}`: a new link; the old one stops working |
| GET | `/api/calendar/<secret>.ics` | | **No login** (calendar apps can't log in; the link is the secret). Your open notes with a date, and those shared with you |

## Plans, backups, measuring

Details: [OPTIMIZATION.md](OPTIMIZATION.md).

| Method | Path | Answer |
|---|---|---|
| GET | `/api/plan` | `{plan, premium, admin, features, billing: {open, manage}}`: `open` = payments set up, `manage` = has a subscription |
| GET / POST | `/api/backups` | list `{premium, keepDays, backups}` / make one now (Premium; 402 otherwise) |
| POST | `/api/backups/:id/restore` | `{restored, rev}`: back to that backup (a backup of now is made first) |
| GET | `/api/backups/:id/download` | the backup as JSON |
| GET | `/api/export` | all my notes and photos, `.tar.gz` (everyone) |
| POST | `/api/billing/checkout` | `{plan: 'solo' \| 'family'}` → `{url}`: Stripe's payment page. 503 `{notOpen: true}` until payments are set up; 409 when already subscribed |
| POST | `/api/billing/portal` | `{url}`: Stripe's page to manage the subscription; 404 without one |
| POST | `/api/billing/webhook` | for Stripe only (signed with `Stripe-Signature`, no login): changes the plan. See docs/PAYMENTS.md |
| GET | `/api/public/experiments?anon=&platform=` | `{subject, variants}` (no login needed) |
| POST | `/api/public/events` | `{anon, platform, events: [{name, props?, ts?}]}` → `{saved}` (no login needed) |
| GET | `/api/admin/overview` | the dashboard's data (owner and `ADMIN_EMAILS` only) |
| POST | `/api/admin/experiments`, `/api/admin/plan`, `/api/admin/optimize` | save a test / give a plan / run the loops now |

## Photos

| Method | Path | Body | Answer |
|---|---|---|---|
| PUT | `/api/images/:name` | the raw image bytes (any `Content-Type` except JSON) | `{"ok":true}`; 403 if the name belongs to someone else |
| GET | `/api/images/:name` | | the image; 404 if it isn't yours |
| PUT / GET | `/api/images/:name?variant=thumb` | the small preview | the preview; GET falls back to the full photo when no preview exists |

**Previews:** apps upload a small preview (320px on the long side) next to each photo and show it in lists. The full photo is downloaded only when it is opened. Photos and previews are cached forever (`Cache-Control: immutable`), because a name never changes its content.

`name` = 8 to 64 letters, digits or `-`, then `.jpg`, `.jpeg`, `.png`, `.webp` or `.gif`. The maximum size is 15 MB. Upload a photo before (or soon after) saving the note that lists it in `images`. If the note was analysed before its photo arrived, the upload queues it again.

**Compression:** JSON answers are gzip-compressed when the client sends `Accept-Encoding: gzip` (all apps do). Photos and live updates are not compressed.

## Live updates

`GET /api/events[?items=1]` is a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream for the logged-in user. Each message is an `event:` line followed by one `data:` line of JSON:

| event | data | when |
|---|---|---|
| `hello` | `{rev, ai}` | right after connecting: pull `/api/notes?since=` to catch up |
| `note` | a note | any of your notes changed (yours, another device's, or the AI's). List items only with `?items=1` |
| `status` | the `ai` status | a reorganize started or finished |

A comment line `: ping` arrives every 25 seconds to keep the connection open.
