# SortMemo on sortmemo.com

The app is renamed SortMemo everywhere people see it. It still runs at
https://record-ai-nina.fly.dev until the steps below are done; after that it
answers at **https://sortmemo.com**, and the old address keeps working.

Internal names stay as they are, on purpose: the Fly app (`record-ai-nina`),
the GitHub repository, the iPhone bundle ID and the Android package. Changing
them would log people out or break the builds, and nobody sees them.

## 1. Point the domain at the server (about 15 minutes, then a wait)

In Terminal on your Mac, in the record.ai folder:

```
fly certs add sortmemo.com
fly certs add www.sortmemo.com
```

Each command prints the DNS records to create. Copy them exactly into GoDaddy:
**My Products → sortmemo.com → DNS** (or **Setting → DNS**), **Add New Record**.
GoDaddy already has an `A @` record ("Parked") and a `CNAME www`: **edit** those
two instead of adding duplicates. They usually look like this:

| Type | Name | Value |
|---|---|---|
| A | @ (or empty) | the IPv4 address Fly shows |
| AAAA | @ (or empty) | the IPv6 address Fly shows |
| CNAME | www | record-ai-nina.fly.dev |

If Fly asks for an `_acme-challenge` CNAME too, add it. Then wait (minutes to
a few hours) and check:

```
fly certs check sortmemo.com
```

When it says the certificate is issued, open https://sortmemo.com: it should
show the app. Then tell Claude **"the domain is ready"**.

## 2. Claude switches the address (no work for you)

Claude changes `PUBLIC_URL` in fly.toml to https://sortmemo.com and the uptime
check to the new address, and merges once the tests pass. From then on,
password emails, invite links and sign-in use the new address.

## 3. Tell the sign-in and calendar services the new address (5 minutes each)

Add these addresses **next to** the old ones (keep the old ones for a month):

| Service | Where | Address to add |
|---|---|---|
| Google sign-in | Google Cloud → APIs & Services → Credentials → your OAuth client → Authorised redirect URIs | https://sortmemo.com/api/auth/oauth/google/callback |
| Google Calendar | the same client, if it is the same one | https://sortmemo.com/api/calendars/google/callback |
| Microsoft (Outlook) | Microsoft Entra → App registrations → your app → Authentication → Redirect URIs | https://sortmemo.com/api/calendars/microsoft/callback |
| Calendly | Calendly developer app → Redirect URI | https://sortmemo.com/api/calendars/calendly/callback |
| GitHub sign-in | GitHub → Settings → Developer settings → OAuth Apps → your app → Authorization callback URL | https://sortmemo.com/api/auth/oauth/github/callback |
| Apple sign-in (when set up) | Apple Developer → Identifiers → your Services ID → Return URLs | https://sortmemo.com/api/auth/oauth/apple/callback |

Only services you have already registered need this. GitHub allows one
callback URL per app: change it when step 2 is done.

## 4. The other two domains forward to sortmemo.com

sortmemos.com (people who type an extra s) and notescircle.com (kept for a
future family-sharing plan) simply send visitors on. For each, in GoDaddy:
**My Products → the domain → Setting → Forwarding → Add forwarding**:

- Forward to: `https://sortmemo.com`
- Type: **Permanent (301)**
- Settings: **Forward only** (not masking)
- Save, and also tick "Update my DNS settings" if GoDaddy asks.

## 5. Emails from your own address

Resend for the emails the app sends, and iCloud+ for your own mailbox
(nina@ and support@sortmemo.com): every step is in EMAIL.md.
