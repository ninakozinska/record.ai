# record.ai for iPhone

A native iPhone app (SwiftUI) for your record.ai notes. It connects to the same server as the web app and uses the same account.

- Write notes, **dictate** them (Apple speech recognition, on the iPhone when supported), **take photos** or pick them from your library.
- Notes sorted by **priority** or **groups**, with search, group filters, swipe to mark done or delete.
- Open a note to edit it, see what the AI found, or choose the group and priority yourself.
- **Works offline:** notes and photos are saved on the iPhone and sync when your server is reachable. Changes from other devices appear live.
- **Account:** log in or sign up, change your password, log out (this removes the notes from the iPhone; they stay on the server). The login token is kept in the iPhone's Keychain.

Requires iOS 17 or newer.

## Put it on your iPhone (free)

You need a Mac with **Xcode**. Xcode is free, but it's a big download, so use Wi-Fi.

1. **Install Xcode** from the Mac App Store. Open it once. When it asks which platforms to install, include **iOS**.
2. **Add your Apple ID:** Xcode → **Settings…** → **Accounts** → **+** → **Apple ID**. A free Apple ID is enough.
3. **On the iPhone, turn on Developer Mode:** Settings → **Privacy & Security** → **Developer Mode** → On. The iPhone restarts.
4. **Connect the iPhone to the Mac with a cable** (only needed the first time). On the iPhone, tap **Trust**.
5. In Finder, open the project folder → **ios** → double-click **RecordAI.swiftpm**. It opens in Xcode.
6. In Xcode's left sidebar, click **record.ai**, then the **Signing & Capabilities** tab. Under **Team**, choose your name (**Personal Team**).
   If Xcode says the bundle identifier is not available, change `com.ninakozinska.recordai` to something unique, such as `com.yourname.recordai`.
7. At the top of the Xcode window, pick **your iPhone** as the device, then press **▶ (Run)**.
8. The first time, the iPhone says **"Untrusted Developer"**. On the iPhone, go to Settings → **General** → **VPN & Device Management** → your Apple ID → **Trust**. Then press ▶ again.
9. In the app, enter your server address. To find it, open record.ai in the browser on your Mac and tap your initials (top right). Then log in.

**With a free Apple ID, the app stops opening after 7 days.** Connect the iPhone and press ▶ in Xcode again; your notes stay. A paid Apple Developer account ($99/year) makes it last a year and lets you share the app through TestFlight.

## Connecting to your server

- **Same network** (home Wi-Fi or your iPhone's hotspot): use the `http://…:3000` address shown in the web app. The first time, the iPhone asks to **find devices on your local network**. Tap **Allow**.
- **From anywhere:** use your Tailscale `https://….ts.net` address.

## Not tested yet

This app was written without access to a Mac, so it has never been compiled. Its Swift syntax has been checked, and its server requests are covered by `test/ios-contract.test.js`. If Xcode shows an error, copy the message and ask for a fix.
