# record.ai for Android

A native Android app (Kotlin, Jetpack Compose) for your record.ai notes. It connects to the same server as the web app and the iPhone app, with the same account.

- Write notes, **dictate** them (Android's speech recognition), **take photos** or pick them from your gallery.
- Notes sorted by **priority** or **groups**, with search and group filters.
- Open a note to edit it, see what the AI found, or choose the group and priority yourself.
- **Always in sync:** while the app is open, changes from your other devices appear within a moment. **Works offline:** notes and photos are saved on the phone and sent as soon as the network is back, even if the app is closed.
- **Share into record.ai:** share text from any app to make a note.
- **Light on battery and data:** one request sends all your edits and fetches all changes; lists download small photo previews only; the live connection closes when the app is in the background.
- Your login is kept encrypted with the phone's Android Keystore.

Requires Android 8.0 or newer.

## Put it on your Android phone (free)

**Easiest: download the ready-made app from GitHub.**

1. On the phone, open **github.com/ninakozinska/record.ai** → **Actions** → the latest green **Tests** run.
2. Under **Artifacts**, download **record-ai-android** (you need to be logged in to GitHub). It's a zip; open it and tap the `.apk` file inside.
3. Android asks to allow installing apps from this source (Chrome or Files). Tap **Settings**, turn it on, go back and tap **Install**.
4. Open record.ai, enter your server address (in the web app on your Mac, tap your initials to see it), and log in.

To update, install a newer `.apk` the same way. Your notes stay.

**Or build it yourself with Android Studio** (free, large download, use Wi-Fi):

1. Install **Android Studio** from developer.android.com/studio and open it once (accept the defaults).
2. **File → Open…** → choose the project folder → **android**. Wait while it downloads what it needs (bottom status bar).
3. On the phone: Settings → **About phone** → tap **Build number** 7 times. Then Settings → System → **Developer options** → turn on **USB debugging**.
4. Connect the phone with a cable and tap **Allow** on the phone.
5. Pick your phone at the top of Android Studio and press **▶ (Run)**.

## Connecting to your server

- **Same network** (home Wi-Fi or a hotspot): use the `http://…:3000` address shown in the web app.
- **From anywhere:** use your Tailscale `https://….ts.net` address.

## How it is built

| Folder | What it is |
|---|---|
| `core/` | The sync engine in plain Kotlin: server API, offline outbox, merge rules, live updates. No Android code, so it is tested against the real server on any computer: `./gradlew :core:test` |
| `app/` | The Android app: screens (Compose), dictation, camera, photo previews, encrypted login storage, background sync (WorkManager) |

The app follows the same sync rules as the web and iPhone apps; see [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md).

**About the downloadable app:** it is signed with a development key, which is fine for your own phones. Publishing on Google Play needs a proper release key (see the next-steps list).
