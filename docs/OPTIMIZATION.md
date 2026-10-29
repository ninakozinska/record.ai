# Measuring and optimization

record.ai measures what people do (never what they write), runs A/B tests on
the web and in the phone apps, and runs optimization loops every hour that
lower costs and raise revenue without lowering quality. The owner sees
everything at **/admin.html** (the 📊 Dashboard link under your initials).

## Events

Stored in the `events` table: name, time, account or anonymous device id,
platform, and small `props` (counts and choices, at most 2 KB). Note text,
titles and photos are never part of an event.

| Event | Sent by | When |
|---|---|---|
| `signup` | server | an account is created (`props.method`: email, google, …) |
| `note_created` | server | a new note (not a list item) |
| `share_created` | server | something is shared (`kind`, `role`, `hasAccount`) |
| `ai_corrected` | server | someone changes a group or priority the AI chose (`field`) |
| `ai_reorganized` | server | a full reorganize ran (`moved`, `total`) |
| `backup_restored`, `export_downloaded`, `plan_changed` | server | as named |
| `app_open` | web, apps | the app starts |
| `premium_seen` | web, apps | the Premium pitch is shown (`pitch`: the variant) |
| `upgrade_click` | web, apps | "Get Premium" is tapped (sent at once) |

Clients send events in batches: `POST /api/public/events` with
`{anon, platform: 'web' | 'ios' | 'android', events: [{name, props?, ts?}]}`
(at most 50; names are `snake_case`). It works before logging in; once a
device logs in (or signs up with the `X-Anon-Id` header), its anonymous
events and test variants move to the account.

## A/B tests

`GET /api/public/experiments?anon=<device id>&platform=ios` returns
`{subject, variants: {premium_pitch: 'family', …}}`. Assignment is random but
**sticky**: stored in `assignments`, so a person always sees the same variant,
and changing the traffic split only affects new people.

An experiment (`server/experiments.js` for the ones a release starts with,
`POST /api/admin/experiments` for new ones):

```json
{ "key": "premium_pitch", "metric": "upgrade_click", "guardrails": ["note_created"],
  "variants": [{"key": "backups", "weight": 50}, {"key": "family", "weight": 50}],
  "auto": true, "minSubjects": 200, "platforms": ["web", "ios", "android"] }
```

A test with `"page": "landing"` belongs to one page: it is assigned only when
that page asks for it (`&keys=landing_headline`), so app users who never see
the page don't dilute it. Running now:

| Test | Variants | Success | Where |
|---|---|---|---|
| `premium_pitch` | backups / family | `upgrade_click` (guardrail `note_created`) | Premium box in the account menu |
| `landing_headline` | two_in_one ("Work and family, in one place") / mental_load ("Get it out of your head. AI sorts it.") | `landing_cta` (a click on Start free / Try it) | `/welcome.html` |

Results (`/api/admin/overview`, the dashboard): per variant the people in it,
how many reached the metric after being assigned, the rate, the change against
the first variant, a two-sided p-value, and the chance it is the best
(Beta posteriors). Clients: `public/track.js` (web),
`android/core/.../Insights.kt`, `ios/RecordAI.swiftpm/Insights.swift`.

## Optimization loops (`server/optimizer.js`)

Run one minute after start, then every hour (`OPTIMIZER=off` disables them).
Every change is written to `optimizer_log` and shown on the dashboard. Limits
are in `LIMITS`.

| Loop | Watches | Changes | Limits |
|---|---|---|---|
| Cost: typing | AI results thrown away because the note changed meanwhile (`ai_calls.outcome = 'stale'`), last 24 h, from 40 calls | How long to wait before sorting a note being typed: doubles above 10% waste, halves below 2% | 0 to 20 s |
| Cost: reorganize | Share of notes the last 3 reorganizes moved, per person | Notes between automatic reorganizes: ×2 below 5% moved, ÷2 above 25% | 10 to 80 |
| Quality guardrail | Share of AI-sorted notes people correct (`ai_corrected` ÷ notes sorted), this week vs last week, from 40 notes each | If it rose by more than 3 points: undoes the reorganize savings | |
| Revenue | Running A/B tests with `auto: true` and enough people | Traffic follows each variant's chance of being best (10% kept for exploring); declares a winner at ≥ 95% if no guardrail dropped more than 10% | |
| Report | Everything above | One row of key numbers per day (`kpi:<day>`) | |

AI cost: every Claude call is stored in `ai_calls` with its tokens and cost
(list prices in `PRICES`; Claude Haiku 5.5: $0.10 / $0.50 per million input /
output tokens).

## Premium and backups (`server/backups.js`)

Plans: `free`, `solo`, `family` (`users.plan`); the first account (the owner)
has everything. Until payments exist the owner gives plans on the dashboard
(`POST /api/admin/plan`). Premium accounts get a backup every day, kept 30
days (plus up to 10 made by hand), can restore any of them (a backup of the
current state is made first) and download one as JSON. Everyone can download
all their notes and photos (`GET /api/export`, a `.tar.gz` with `notes.json`,
`notes.md` and `photos/`).
