# Turning on two-way calendars (P0-5)

record.ai will connect to **Google Calendar (Gmail)**, **Outlook and Microsoft 365**,
**Calendly** and **Apple iCloud**. Each person connects their own calendar from the
account menu:

- Meetings and appointments show on the Today line and as notes.
- A note with a date goes into the calendar they chose, and changes flow both ways.
- Calendly bookings arrive as notes. Calendly only sends; nothing is written back to it.

Only one part is yours: registering record.ai with Google, Microsoft and Calendly,
and putting their keys on the server. Apple needs nothing from you. Claude builds
the rest. All of it is free.

**About 1 hour in all.** Do them in this order. Each one can be switched on alone.

Throughout, the server address is `https://record-ai-nina.fly.dev`. When you move to
your own domain, add the new addresses next to the old ones, the same way.

> Never paste a secret into a chat, an email or a screenshot. Copy each one
> straight into the Terminal command at the end. When you're done, just tell Claude "done".

## 0. Before you start (5 minutes)

- Have the Fly command ready on your Mac. Running `fly auth whoami` in Terminal
  should print your email.
- Make the key that locks the calendar connections on the server. The server keeps
  every calendar connection encrypted with this key. The command makes a random key
  and stores it on Fly without showing it to anyone:

  ```
  fly secrets set CALENDAR_KEY=$(openssl rand -hex 32)
  ```

  Run it **once only**. A new key would disconnect everyone's calendars.

## 1. Google Calendar and Gmail (about 20 minutes)

You can use the same Google project as "Continue with Google" (docs/SOCIAL_LOGIN.md).
If you don't have one yet, create it now. It will serve both.

1. Go to [console.cloud.google.com](https://console.cloud.google.com). At the top,
   pick the project, or create one called **record.ai**.
2. **APIs & Services → Library**: search **Google Calendar API**, open it, click **Enable**.
3. **Google Auth Platform** (older screens: **OAuth consent screen**):
   - **Branding**: app name *record.ai*, your support email. App home page and
     privacy policy: `https://record-ai-nina.fly.dev/` and
     `https://record-ai-nina.fly.dev/legal/privacy.html`.
   - **Audience**: **External**. Under **Test users**, add your Gmail address, your
     partner's address and those of your first beta testers (up to 100).
   - **Data access → Add or remove scopes**: tick
     `.../auth/calendar.events` (see, change and delete events in your calendars).
     If it isn't in the list, paste it in **Manually add scopes** as
     `https://www.googleapis.com/auth/calendar.events`. Click **Update**, then **Save**.
4. **Clients** (or **Credentials**): open your **Web application** client, or
   **Create client → Web application** if you have none.
   - Under **Authorized redirect URIs**, add
     `https://record-ai-nina.fly.dev/api/calendars/google/callback`
   - Click **Save**.
5. Copy the **Client ID** and the **Client secret**. If this is the same client as
   "Continue with Google", the server already knows them; skip to the next section.

**What "Testing" means.** While the app is in Testing, only the test users can connect,
and Google asks them to reconnect every 7 days. That's fine for the beta. Before the
public launch, Google must **verify** the app, because it changes calendars. That
needs your own domain, the privacy policy on that domain, and a short video of the
connect screen. Expect a few days to a few weeks. Claude prepares the video and the
texts when the domain is ready.

## 2. Outlook and Microsoft 365 (about 15 minutes)

You can use the same app registration as "Continue with Microsoft", if you made one.

1. Go to [entra.microsoft.com](https://entra.microsoft.com) and sign in with a Microsoft
   account. If it asks you to create a directory or a free Azure account, do it: the
   free account may ask for a card but does not charge for this.
2. **Applications → App registrations**. Open the record.ai app, or **New registration**:
   - Name: *record.ai*
   - Supported account types: **Accounts in any organizational directory and personal
     Microsoft accounts**
   - Redirect URI: **Web**, `https://record-ai-nina.fly.dev/api/calendars/microsoft/callback`
   - **Register**.

   If the app already existed: **Authentication → Add a platform or Add URI** and add
   the same redirect URI. **Save**.
3. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
   Tick **Calendars.ReadWrite**, **offline_access** and **User.Read**, then **Add permissions**.
   Don't click "Grant admin consent": each person agrees for themselves.
4. **Overview**: copy the **Application (client) ID**.
5. **Certificates & secrets → New client secret**:
   - Pick 24 months.
   - Copy its **Value** right away (not the Secret ID). It is shown only once.
   - Put a reminder in your calendar for a month before it expires.

**Later, for companies.** Some companies only let their staff connect apps from a
*verified publisher*. That needs a free Microsoft AI Cloud Partner Program account.
It only matters for the company plan; personal Outlook and Hotmail accounts work
without it.

## 3. Calendly (about 10 minutes)

1. Go to [developer.calendly.com](https://developer.calendly.com) and log in with
   your Calendly account (a free one works).
2. Choose **Create a new app** (under My Apps):
   - Name: *record.ai*
   - Kind of app: **Web**
   - Environment: **Production** (Sandbox only allows `localhost` addresses)
   - Redirect URI: `https://record-ai-nina.fly.dev/api/calendars/calendly/callback`
3. Save. Calendly then shows three values: **Client ID**, **Client secret** and
   **Webhook signing key**. Copy all three now; the secret and the signing key are shown once.

There's no webhook to add by hand: record.ai subscribes to new and cancelled bookings
for each person when they connect.

**To know.** Calendly sends bookings as they happen only for people on a **paid
Calendly plan** (Standard or higher; check Calendly's current plans). For people on
the free plan, record.ai checks for new bookings every 15 minutes instead.

## 4. Apple iCloud (nothing to do)

Apple has no developer sign-up for iCloud calendars. When someone connects iCloud,
record.ai shows them three steps:

1. Open [account.apple.com](https://account.apple.com).
2. **Sign-In and Security → App-Specific Passwords → +**.
3. Paste that password into record.ai. It only opens their calendars, and they can
   revoke it there at any time.

Two-factor authentication must be on, as it is on almost every Apple account.

## 5. Put the keys on the server (5 minutes)

In Terminal, all in one command. Replace each `…` with the value you copied.
Leave out a line for a service you skipped.

```
fly secrets set \
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
  MICROSOFT_CLIENT_ID=… MICROSOFT_CLIENT_SECRET=… \
  CALENDLY_CLIENT_ID=… CALENDLY_CLIENT_SECRET=… CALENDLY_WEBHOOK_KEY=… \
  PUBLIC_URL=https://record-ai-nina.fly.dev
```

The app restarts by itself. If Google or Microsoft keys were already set for sign-in,
leave those lines out: the same keys serve both.

Then tell Claude **"done"**, and which ones you set up. Don't send the values.
Claude checks that the server sees them (it can see the setting names, never the values).

## 6. Try it (once the feature is built)

1. Account menu → **Calendars → Connect Google**. Agree on Google's page.
2. A meeting that is in Google Calendar today appears on the Today line within a minute.
3. Write "Dentist Friday 3pm". It appears in Google Calendar as an event.
4. Move that event to 4pm in Google Calendar. The note shows 4pm.
5. Repeat with Outlook, and with a test booking on your Calendly page.

## What it costs

| Service | Price | Limits that matter |
|---|---|---|
| Google Calendar API | Free | Generous daily quota; verification needed before launch |
| Microsoft Graph | Free | Client secret to renew every 2 years at most |
| Calendly API | Free | Live bookings need a paid Calendly plan per user; else every 15 min |
| iCloud (CalDAV) | Free | Each person makes an app-specific password |
