# Put record.ai online with Fly.io

Your notes then live on a small server in Frankfurt, reachable from anywhere at `https://<your-app>.fly.dev`. Your Mac no longer needs to be on.

**What it costs:** about $3.50 a month.
- A 512 MB machine: about $3.19.
- A 1 GB disk for your notes and photos: $0.15.
- Daily backups of that disk, kept 5 days: free up to 10 GB.

Fly bills pay-as-you-go to a credit card. The AI (Claude Haiku) is billed separately by Anthropic: a few cents a month for a few people.

You type a few commands into **Terminal**. Copy each line, paste it into Terminal, and press **Enter**.

## 0. Get the newest record.ai on your Mac

The Fly.io settings (`fly.toml`) arrived after your last update.

1. Download https://github.com/ninakozinska/record.ai/archive/refs/heads/claude/notes-app.zip and unzip it.
2. Open the new folder, select everything (⌘A), and copy it (⌘C).
3. Open your **record.ai-claude-notes-app** folder and paste (⌘V). Choose **Apply to all → Replace**.

## 1. Install the Fly tool and log in

Open **Terminal**: press ⌘ Space, type *Terminal*, and press Enter. Then run:

```
curl -L https://fly.io/install.sh | sh
```
```
export PATH="$HOME/.fly/bin:$PATH"
```
```
fly auth signup
```

Signing up opens Chrome. Create the account, or use `fly auth login` if you already have one. Fly asks for a credit card before you can create apps.

## 2. Create the app and its disk

```
cd ~/record.ai-claude-notes-app
```
```
fly apps create record-ai-nina
```

If Fly says the name is taken, pick another, for example `record-ai-nina2`. Then tell Claude, because it also has to be changed in `fly.toml`.

```
fly volumes create data --region fra --size 1 --app record-ai-nina
```

If Fly warns that one volume alone has no copy on another machine, type `y`. Your daily snapshots are your backup.

## 3. Put it online

```
fly deploy --remote-only
```

This takes 2–4 minutes; Fly builds the app on its own computers. When it says the machine is healthy, open **https://record-ai-nina.fly.dev**. You'll see record.ai asking you to create an account. **Don't create one yet** if you're moving your notes in the next step.

## 4. Move your notes from your Mac

1. **Stop record.ai on your Mac:** close its Terminal window. This makes sure the notes file is complete.
2. In Terminal, pack your notes and photos into one file:

   ```
   COPYFILE_DISABLE=1 tar -czf ~/record-data.tar.gz -C ~/record.ai-claude-notes-app/data .
   ```

3. Send that file to the server:

   ```
   fly ssh sftp shell --app record-ai-nina
   ```

   A `»` prompt appears. Type this line, then press Control + D to leave:

   ```
   put /Users/kozinskanina/record-data.tar.gz /data/import.tar.gz
   ```

4. Restart the app. It unpacks the file when it starts:

   ```
   fly apps restart record-ai-nina
   ```

Open https://record-ai-nina.fly.dev and log in with **the same email and password as on your Mac**. Your notes are there.

From now on, use the online address everywhere. Don't keep adding notes on the Mac's own copy, or you'll have two separate sets of notes.

## 5. Turn on the AI (Claude)

Online, the free Ollama AI can't run; the server is far too small. record.ai uses **Claude Haiku**, Anthropic's fast and cheap model.

1. At https://console.anthropic.com, add a little credit (the minimum is fine) and create an API key.
2. In Terminal, run the line below with your own key. **Never paste the key into a chat.**

   ```
   fly secrets set ANTHROPIC_API_KEY=sk-ant-...your key... --app record-ai-nina
   ```

The app restarts by itself and starts organizing notes.

## 6. Point your phones and browsers at the new address

- **Web:** bookmark https://record-ai-nina.fly.dev. On a phone, use **Add to Home Screen** so it works like an app.
- **iPhone and Android apps:** log out (your initials → Log out), tap **Use a different server**, and enter `https://record-ai-nina.fly.dev`.

## Later: automatic updates (optional)

Today, an update means running `fly deploy --remote-only` again from the app folder. To let GitHub do it after every change, once the tests pass:

1. In Terminal, run `fly tokens create deploy --app record-ai-nina` and copy the long token it prints.
2. On GitHub, go to **record.ai → Settings → Secrets and variables → Actions → New repository secret**. Name it `FLY_API_TOKEN`, paste the token, and save.

The workflow `.github/workflows/deploy-fly.yml` then deploys every change that reaches `main`.

## Good to know

- **Backups:** Fly snapshots the disk every day and keeps each snapshot 5 days. To see them, run `fly volumes snapshots list <volume id>`. To find the id, run `fly volumes list`.
- **Forgot your password?** Run `fly ssh console --app record-ai-nina -C "node scripts/reset-password.mjs you@example.com 'new password'"`.
- **What's happening on the server:** `fly logs --app record-ai-nina`.
- **"Continue with Google" and the others:** use `https://record-ai-nina.fly.dev` as the address in [SOCIAL_LOGIN.md](SOCIAL_LOGIN.md), and put the keys in with `fly secrets set`.
