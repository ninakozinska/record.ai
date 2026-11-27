# Backups

SortMemo keeps three kinds of copy, each for a different accident.

| Copy | What it covers | When, how long | Where |
|---|---|---|---|
| On each device | No signal, a server hiccup | Always | The phone or laptop |
| Personal backups (Premium) | "I deleted the wrong list" | Daily, kept 30 days, plus Back up now | The server's disk (`server/backups.js`) |
| Offsite copy | The server or the hosting account is lost | Every night, kept 30 days | Cloudflare R2 (`server/offsite.js`) |

## The offsite copy (Cloudflare R2)

Every night the server makes a consistent copy of the whole database (`VACUUM INTO`),
compresses it and uploads it to R2 as `db/YYYY-MM-DD.db.gz`. It then downloads the copy
again and checks its size, and removes copies older than 30 days. It runs a minute after
each start and then once a day (checked every hour).

If an upload fails or the copy comes back incomplete, the server's admins (the first
account and `ADMIN_EMAILS`) get one email that day, and the server tries again an hour later.

Turn it on with four Fly.io secrets (the key needs only "Object Read & Write" on that one bucket):

```
fly secrets set R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com R2_BUCKET=sortmemo-backups
```

For a bucket in the EU jurisdiction the endpoint has `.eu.` in it, as above.

### Checking it

- **Every night, automatically:** the read-back check above; a failure emails you.
- **Once a week, yourself:** open the bucket in Cloudflare and look for a file for every night.
- **Once a month, a real test restore:** download a copy, unzip it (`gunzip`) and open it
  as the server's `notes.db` on a test machine, then check the notes are there.
