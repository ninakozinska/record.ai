# What each app can do: web, iPhone, Android

The web app (`public/`) is the reference. This table compares it with the
iPhone app (`ios/RecordAI.swiftpm`) and the Android app (`android/`), as of
23 November 2026, **before** and **after** the store-release work on the
`claude/store-release` branch.

✓ = yes · partial = some of it · ✗ = no · — = not meant for phones

| Feature | Web | iPhone before | iPhone now | Android before | Android now |
|---|---|---|---|---|---|
| Write, dictate 🎤, photograph 📷 or pick photos | ✓ | ✓ | ✓ | ✓ | ✓ |
| Checklists ("- " lines), tick, add, remove items | ✓ | ✓ | ✓ | ✓ | ✓ |
| Paste several lines: one list or separate notes | ✓ | ✓ | ✓ | ✓ | ✓ |
| Priority / Groups views, done notes, clear done with Undo | ✓ | ✓ | ✓ | ✓ | ✓ |
| Search | ✓ | ✓ | ✓ | ✓ | ✓ |
| Search inside list items, and `label:x` search | ✓ | ✗ | ✓ | ✗ | ✓ |
| Worlds switch: All, Work, Family, School | ✓ | ✓ | ✓ | ✓ | ✓ |
| School: one group per child ("School · Name"), **＋ Child** | ✓ | ✗ | ✓ | ✗ | ✓ |
| Children (and other own groups) shown even with no notes yet | ✓ | ✗ | ✓ | ✗ | ✓ |
| "🎒 Which child?" on School notes without a child | ✓ | ✗ | ✓ | ✗ | ✓ |
| Choose a note's world in the editor | ✓ | ✗ | ✓ | ✗ | ✓ |
| Group's world shown in Groups view, tap to move | ✓ | ✗ | ✓ | ✗ | ✓ |
| ＋ Group (my own groups), remove under Account | ✓ | ✗ | ✓ | ✗ | ✓ |
| Labels like Gmail (Premium): shown on notes | ✓ | ✗ | ✓ | ✗ | ✓ |
| Labels: toggle in the editor, ＋ Label, filter chips | ✓ | ✗ | ✓ | ✗ | ✓ |
| My labels: remove under Account | ✓ | ✗ | ✓ | ✗ | ✓ |
| Edit a note: text, photos, group, priority (📌 your choice) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Date and time, "Let AI decide", add to phone calendar | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reminder picker on a note | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reminders and morning briefing **delivered** as notifications | ✓ | ✗ | ✗ | ✗ | ✗ |
| Family hub: who a note is for | ✓ | ✓ | ✓ | ✓ | ✓ |
| Who a list item is for, item priority | ✓ | ✗ | ✗ | partial (shows who) | partial (shows who) |
| Share a note | ✓ | ✓ | ✓ | ✓ | ✓ |
| Share a whole group | ✓ | ✗ | ✓ | ✗ | ✓ |
| Share all of School (share kind `school`) | ✓ | ✗ | ✓ | ✗ | ✓ |
| Leave something shared with me (note, group or School) | ✓ | partial (not School) | ✓ | partial (not School) | ✓ |
| Send a note by email / WhatsApp / any app, "Sent from SortMemo" | ✓ | ✓ | ✓ | ✓ | ✓ |
| Note history | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read a note aloud (Premium), choose voice and speed | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hear today | ✓ | ✓ (+ Siri) | ✓ (+ Siri) | ✓ (+ icon shortcut) | ✓ (+ icon shortcut) |
| Turn a letter or photo into tasks | ✓ | ✓ | ✓ | ✓ | ✓ |
| Re-analyze a note, Reorganize everything | ✓ | ✓ | ✓ | ✓ | ✓ |
| Suggested to-dos: review, add, edit and add, dismiss, suggest now | ✓ | ✗ | ✓ | ✗ | ✓ |
| Suggested to-dos: settings, to-dos from an AI chat export | ✓ | ✗ | ✗ (web) | ✗ | ✗ (web) |
| 7 languages | ✓ (choose) | ✓ (phone's language) | ✓ | ✓ (phone's language) | ✓ |
| AI names new groups in your language | ✓ | ✗ | ✓ | ✗ | ✓ |
| Light / Dark | ✓ (choose) | ✓ (follows phone) | ✓ | ✓ (follows phone) | ✓ |
| Works offline, live sync | ✓ | ✓ | ✓ | ✓ | ✓ |
| Log in, sign up, forgot password | ✓ | ✓ | ✓ | ✓ | ✓ |
| Continue with Google / Apple / … (when set up on the server) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change password, log out other devices, delete account | ✓ | ✓ | ✓ | ✓ | ✓ |
| Premium backups: back up now, restore | ✓ | ✓ | ✓ | ✓ | ✓ |
| Privacy, Terms, Help links in the app | ✓ | ✗ | ✓ | ✗ | ✓ |
| Send feedback | ✓ | ✗ | ✓ | ✗ | ✓ |
| Starts on sortmemo.com (no server address to type) | ✓ | ✗ | ✓ | ✗ | ✓ |
| Buy Premium | ✓ (Stripe) | ✗ | ✗ | ✗ | ✗ |
| Download all my notes | ✓ | ✗ | ✗ (web) | ✗ | ✗ (web) |
| Connect calendars (Google, Outlook, iCloud, Calendly), calendar link | ✓ | ✗ | ✗ (web) | ✗ | ✗ (web) |
| Connect AI assistants (Claude, ChatGPT, Gemini) | ✓ | ✗ | ✗ (web) | ✗ | ✗ (web) |
| Today card, welcome card with example notes | ✓ | ✗ | ✗ | ✗ | ✗ |
| Owner dashboard, invite codes, error test | ✓ (owner) | — | — | — | — |

## Left out on purpose, and why

- **Notifications on the phones** (reminders, morning briefing): the server
  sends them with web push only. The phone apps need Apple's (APNs) and
  Google's (Firebase) push keys, which only Nina can create, plus server
  work to send to them. The reminder picker works on the phones already: the
  reminder reaches the web app installed on the home screen. A good next
  step after launch.
- **Buying Premium in the apps**: Apple and Google require their own
  in-app purchase for digital subscriptions sold inside an app, and do not
  allow a button or link to buy on the website. Version 1.0 of the apps sells
  nothing; Premium bought on sortmemo.com works in the apps. Adding Apple and
  Google subscriptions is its own project (products set up by Nina in both
  stores, then StoreKit, Play Billing and server checks).
- **Calendars and AI assistants**: they are connected once, in a browser,
  with the other service's sign-in page. The phones show the result (meetings
  become notes), so the set-up can stay on the web.
- **Download all my notes**: on the web, under your initials. A phone copy
  would need a file share sheet; not needed for the stores (deleting the
  account in the app is what they require).
- **Suggested to-do settings and AI chat uploads**: set once on the web; the
  phones show and review the suggestions.
- **Who a list item is for, item priority**: shown on Android, not editable
  on either phone yet. Small; can follow after launch.
- **Owner dashboard, invite codes, Sentry test error**: tools for the
  server's owner, on the web only.
