# Email on sortnotes.com

Two services, two jobs:

| | Resend | iCloud+ custom email domain |
|---|---|---|
| What for | Emails the **app** sends by itself (password reset, invites) | **Your** mailbox: nina@ and support@sortnotes.com |
| Where the records go | `send.sortnotes.com` | `sortnotes.com` |
| Cost | Free up to 3,000 emails a month | Included in iCloud+ (from €0.99 a month) |

They do not clash, and neither touches the A, AAAA and www records that point
the domain at the app (DOMAIN.md).

## Part A. Resend: emails from the app (about 20 minutes, then a wait)

1. Go to https://resend.com, **Get Started**, sign up (no card needed).
2. **Domains → Add Domain**: name `sortnotes.com`, region **Ireland (eu-west-1)**, **Add**.
3. Resend shows 3 or 4 records. In GoDaddy (**My Products → DNS** next to
   sortnotes.com) add each with **Add New Record**, copying Name and Value
   from Resend's copy buttons. Where Resend shows `send.sortnotes.com`, type
   only `send`. MX priority: 10.
4. Back in Resend: **Verify DNS Records**. Wait until it says **Verified**
   (minutes to a few hours).
5. **API Keys → Create API Key**: name `sortnotes-fly`, permission **Sending
   access**, domain `sortnotes.com`. Copy the key (shown once, starts `re_`).
6. In Terminal, in the record.ai folder (your key in place of `re_YOUR_KEY`):

   ```
   fly secrets set RESEND_API_KEY=re_YOUR_KEY
   fly secrets set MAIL_FROM="SortNotes <hello@sortnotes.com>"
   ```

Tell Claude "Resend done" (never the key).

## Part B. iCloud+: your own addresses (about 20 minutes, then a wait)

1. On the iPhone: **Settings → your name → iCloud**. You need a paid plan
   (iCloud+, 50 GB is €0.99 a month) and **iCloud Mail** switched on.
2. On a computer, https://icloud.com → your name (top right) → **iCloud
   Settings → Custom Email Domain → Manage**.
3. **Only you → Use a domain you own** → `sortnotes.com` → **Continue**.
   No existing addresses: start fresh.
4. If Apple offers automatic setup with GoDaddy, use it. Otherwise add its
   records in GoDaddy, copying the values from Apple's screen:

   | Type | Name | Value | Priority |
   |---|---|---|---|
   | MX | `@` | `mx01.mail.icloud.com` | 10 |
   | MX | `@` | `mx02.mail.icloud.com` | 10 |
   | TXT | `@` | `apple-domain=…` (yours) | |
   | TXT | `@` | `v=spf1 include:icloud.com ~all` | |
   | CNAME | `sig1._domainkey` | `sig1.dkim.sortnotes.com.at.icloudmailadmin.com` | |

   First delete any MX records GoDaddy already has on `@`.
5. Back in iCloud: **Finish setup**. Wait until the domain is ready.
6. **sortnotes.com → Add an email address**: `nina@sortnotes.com`, then
   `support@sortnotes.com`. They appear in Mail on your iPhone and Mac; pick
   the sender under **From** when writing.
7. So that replies to the app's emails reach you:

   ```
   fly secrets set MAIL_REPLY_TO=support@sortnotes.com
   ```

Tell Claude "iCloud email done".

## Optional, after both: DMARC

One more TXT record in GoDaddy, name `_dmarc`, value `v=DMARC1; p=none;`.
It tells other mail servers how to treat email that claims to be from your
domain, and helps both kinds of email avoid spam folders.

## What GoDaddy's DNS page looks like at the end

| Type | Name | Points to | Set by |
|---|---|---|---|
| A, AAAA | `@` | Fly's addresses | DOMAIN.md |
| CNAME | `www` | record-ai-nina.fly.dev | DOMAIN.md |
| MX ×2, TXT ×2 | `@` | iCloud | Part B |
| CNAME | `sig1._domainkey` | iCloud | Part B |
| MX, TXT | `send` | Resend | Part A |
| TXT | `resend._domainkey` | Resend | Part A |
| TXT | `_dmarc` | DMARC | optional |
| NS, SOA | `@` | GoDaddy | leave alone |
