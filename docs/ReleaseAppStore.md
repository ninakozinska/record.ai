# Putting SortMemo on the App Store and Google Play

This guide takes the SortMemo iPhone app and Android app from this repository
to the App Store and Google Play, one click at a time. It is written for a
Mac, and for someone who is not a developer.

Two marks show who can do each step:

- 🔐 **Only you**: it needs your Apple, Google, GitHub or Fly account, your
  money, your identity or your signature. Nobody can do it for you.
- 🛠 **A helper can do it**: a developer (or Claude) can do it, or you can do
  it yourself by following the steps.

What it costs: Apple **$99 a year**, Google **$25 once**. How long it takes:
plan **about three weeks** for Google (a 14-day test is required, see below)
and **one or two weeks** for Apple (account checks, then review, which
usually takes one to three days).

The texts to paste into both stores (name, subtitle, keywords, descriptions,
"What's new", in seven languages) are in **[STORE.md](STORE.md)**. What each
app can do compared with the web app is in **[PARITY.md](PARITY.md)** (and
summed up at the end of this guide).

---

## The facts you will type, in one place

| What | Value |
|---|---|
| App name in the stores | **SortMemo: AI Notes & Lists** (26 characters; at most 30). If Apple says the name is taken, use **SortMemo – Family Notes**. |
| Name under the icon on the phone | SortMemo |
| iPhone **Bundle ID** | `com.ninakozinska.recordai` |
| Android **package name** (applicationId) | `com.ninakozinska.recordai` |
| Version | **1.0.0** (iPhone build **1**, Android version code **1**) |
| Category | Productivity (Apple second category: Lifestyle) |
| Price | Free. Version 1.0.0 sells nothing inside the app (see "Premium" below). |
| Privacy policy | https://sortmemo.com/legal/privacy.html |
| Support page | https://sortmemo.com/legal/support.html |
| Account deletion page (Google asks) | https://sortmemo.com/legal/delete-account.html |
| Marketing page (optional) | https://sortmemo.com |
| Copyright line (Apple) | `2026 <your name or your business name>` |
| SKU (Apple, only for you) | `sortmemo-ios` |
| Ads in the app | None |
| Where the data is kept | Fly.io, Frankfurt, Germany (EU) |

The Bundle ID and the package name can **never change** once the app is in a
store. They are already set in the code (ios/RecordAI.swiftpm/Package.swift
and android/app/build.gradle.kts). They are unique and belong to you, so you
can keep them. If you would rather have names that match the new brand, such
as `com.sortmemo.app`, decide **before** step A3 and ask a helper to change
both files first (🛠, five minutes). After the first upload it is too late.

---

## Before you start: six things to settle

1. 🔐 **Finish the legal pages.** Three pages in public/legal/ still say
   "Draft" at the top: privacy.html, terms.html and delete-account.html. The
   contact address is already filled in everywhere (support@sortmemo.com).
   What is still to do, exactly:
   - **privacy.html**: the "Draft, 31 October 2026" banner; `[Business name]`,
     `[address]`, `[VAT number]`; `[When subscriptions inside the apps
     launch:]` (keep the line about Apple and Google only once the apps sell
     something, otherwise delete it); `[Confirm and list transfers outside the
     EU, e.g. Anthropic in the US, with the safeguards used.]`; `[Check the age
     for Italy and for the app stores.]`.
   - **terms.html**: the "Draft, 29 October 2026" banner; `[business name]`,
     `[address]`; `[Limitation of liability, as allowed by Italian and EU
     consumer law.]`; `[Add the EU 14-day withdrawal rules for purchases on the
     web.]`.
   - **delete-account.html**: the "Draft, 31 October 2026" banner (nothing
     else in brackets).
   - **support.html**: nothing in brackets; check that the answers are true.

   Both stores reject apps whose privacy policy is unfinished. Fill them in (a
   helper can edit the pages; the facts are yours), ideally after a lawyer or
   commercialista has read them, then remove the Draft banners.
2. 🔐 **A support email address that works.** Done: support@sortmemo.com
   exists (iCloud+, see docs/EMAIL.md) and has been tested. Both stores show
   it publicly: send it a test email before submitting, to check it still
   arrives.
3. 🔐 **Keep sign-up invite-only.** Don't open sign-up for everyone
   (no `ALLOW_SIGNUP=true`): the reviewers don't need it, because the demo
   account (point 4) is made directly on the server. In the review notes
   (A7, B5) write: "Sign-up is invite-only during our alpha; please use the
   demo account above." Optionally, make one personal invite link for the
   reviewers in the owner's dashboard (🎟 Alpha invites), named "App Review",
   and paste its code in the review notes too, in case they want to try
   signing up.
4. 🔐 **A demo account for the reviewers**, with Premium and example notes. In
   Terminal, run (choose your own password, at least 12 characters):

   ```bash
   fly ssh console -C "node /app/scripts/demo-account.mjs appreview@sortmemo.com 'Choose-A-Long-Password-1'"
   ```

   (The app lives in the /app folder on the server, so the full path is
   needed.) The address does not need to receive email. Write the email and
   password in your password manager: both stores ask for them. Log in with it
   once on sortmemo.com to check it shows the example notes. After the review,
   change the demo account's password (run the same command with a new
   password, or log in and change it under your initials), and give the
   reviewers the new one at the next submission.
5. 🔐 **Premium in the apps.** Apple and Google only allow digital
   subscriptions to be sold inside an app with their own payment system, and
   forbid buttons or links that send people to pay on a website. Version 1.0.0
   of the apps therefore sells nothing: no prices, no "Get Premium", no links
   to pay. People who bought Premium on sortmemo.com get it in the apps too,
   and the apps say "part of Premium" next to Premium features. Apple's rule
   3.1.3(b) says such apps should *also* offer the subscription inside the
   app; many apps pass review without it, some are asked to add it. If Apple
   asks, the choice is yours: add Apple's and Google's subscriptions (a
   development project, with products you create in both stores), or ship
   without Premium features in the app. Decide which you'd prefer before you
   submit, so the answer is ready.
6. 🔐 **EU "trader" status.** Because SortMemo earns money (Premium), the EU
   Digital Services Act makes you a *trader*. Both stores then show your
   address, phone number and email on the app's page in the EU. Use a business
   address and number if you don't want your home ones shown. Without this,
   Apple does not publish the app in the EU.

---

## Part A: the App Store (iPhone)

### A1. Join the Apple Developer Program 🔐

You need a Mac, your Apple ID with two-factor authentication on, and $99 a
year.

**Individual or organization?**

| | Individual | Organization |
|---|---|---|
| Shown in the App Store as the seller | Your own name | Your company's name |
| Needs | Your Apple ID and an ID document | A company (legal entity), a **D-U-N-S number**, a website on its own domain, and the right to sign for the company |
| Time | Usually 1–2 days | 1 to 2 weeks (getting a D-U-N-S number is free but slow) |

If SortMemo is run by a company (for example an Italian SRL), choose
**Organization**. Look up or request the company's D-U-N-S number first, free,
from Apple's D-U-N-S lookup page (developer.apple.com/enroll/duns-lookup). If
you are a sole trader (ditta individuale) or just starting, **Individual** is
simpler and can be moved to an organization later through Apple support.

1. On your iPhone, install the **Apple Developer** app from the App Store.
2. Open it, sign in with your Apple ID, tap **Account** → **Enroll Now**.
3. Choose Individual or Organization, follow the steps, scan your ID, pay.
4. Wait for the "Welcome to the Apple Developer Program" email.

### A2. Install Xcode and sign in 🔐

1. Install **Xcode** from the Mac App Store (free, very large: use Wi-Fi). Open
   it once; when it asks which platforms to install, include **iOS**. The
   current Xcode needs a recent macOS: if the Mac App Store says your Mac is
   too old, update macOS first (Apple menu → System Settings → General →
   Software Update). Apple only accepts uploads built with the current iOS
   SDK, which comes with the current Xcode, so keep Xcode up to date.
2. Xcode → **Settings…** → **Accounts** → **+** → **Apple ID**, and sign in with
   the Apple ID that has the developer membership. Your team appears with the
   role "Account Holder".

### A3. Reserve the Bundle ID 🔐

1. Go to developer.apple.com/account → **Certificates, IDs & Profiles** →
   **Identifiers** → the blue **+**.
2. Choose **App IDs** → Continue → **App** → Continue.
3. Description: `SortMemo`. Bundle ID: **Explicit**, `com.ninakozinska.recordai`
   (or the new one you decided on).
4. Leave all capabilities off. **Continue** → **Register**.

### A4. Create the app in App Store Connect 🔐

1. Go to appstoreconnect.apple.com → **Apps** → **+** → **New App**.
2. Platforms: **iOS**. Name: **SortMemo: AI Notes & Lists**. Primary language:
   **English (U.S.)**. Bundle ID: choose `com.ninakozinska.recordai` from the
   list. SKU: `sortmemo-ios`. User access: **Full Access**. Click **Create**.
3. Under the app's **App Information** page, add **Italian** (top right,
   next to the language name) and the other languages from STORE.md if you
   want them.

### A5. Build the app and upload it 🔐 (a helper can do it on your Mac with you signed in)

1. In Finder, open the project folder → **ios** → double-click
   **RecordAI.swiftpm**. It opens in Xcode. (The folder keeps its old name on
   purpose; the app is called SortMemo.)
2. In the left sidebar click **SortMemo** (the top line), then the
   **Signing & Capabilities** tab. Under **Team** choose your paid team (your
   name or company, **not** "Personal Team"). Check that the Bundle Identifier
   says `com.ninakozinska.recordai`.
3. At the top of the window, where it shows a device, choose **Any iOS Device
   (arm64)**.
4. Menu **Product** → **Archive**. Wait a few minutes. The **Organizer** window
   opens with the new archive selected.
5. Click **Distribute App** → **App Store Connect** (in newer Xcode:
   **TestFlight & App Store**) → **Distribute** (or **Next** until **Upload**).
   Let Xcode manage signing when it asks.
6. When it says "Uploaded", wait 15–30 minutes. Apple emails you when the build
   has been processed. It then shows in App Store Connect → your app →
   **TestFlight**.

The app already tells Apple it uses only standard encryption (HTTPS), so you
are not asked about export compliance.

**Check the privacy manifest once (first upload).** The app's privacy
manifest (PrivacyInfo.xcprivacy) must be inside the app, at its top level. The
project is a Swift package, which may put such files one folder deeper, in a
separate bundle, where Apple doesn't look. After step 4 (Archive), in the
Organizer window: right-click the archive → **Show in Finder** → right-click
the `.xcarchive` file → **Show Package Contents** → **Products** →
**Applications** → right-click the app (**SortMemo**) → **Show Package
Contents**. `PrivacyInfo.xcprivacy` must be right there, not only inside a
folder whose name ends in `.bundle`. (Or: right-click the archive in the
Organizer → **Generate Privacy Report**; the report must list SortMemo's data
types.) If it is missing, or if App Store Connect later emails a warning
**ITMS-91053** ("Missing API declaration"), ask Claude (or a developer) to
move the iPhone app to a regular Xcode project, which places the file
correctly; then archive and upload again.

For every later upload, a helper raises the build number by 1 in
ios/RecordAI.swiftpm/Package.swift (`bundleVersion: "2"`, then `"3"`…), and the
version (`displayVersion`) for each new release, such as `"1.0.1"`.

### A6. Try it with TestFlight 🔐

1. App Store Connect → your app → **TestFlight** → **Internal Testing** → **+**
   to make a group (for example "Family") and add yourself and up to 100
   people from your team (they must be added under **Users and Access** first).
2. Install **TestFlight** from the App Store on your iPhone, open the invitation
   email, tap **Install**.
3. Try everything once: sign up with an invite link, log in, write, dictate,
   take a photo, open a note, labels, the School world, share, Hear today,
   log out, log in again.
4. Friends outside your team: **External Testing** → new group → add their
   emails. The first external build is checked by Apple (about a day).

### A7. Fill in the App Store page 🔐

Everything below is in App Store Connect → your app.

**App Information** (left menu):

- Subtitle: from STORE.md (English: "Notes and lists the AI sorts").
- Category: **Productivity**, secondary **Lifestyle**.
- Content Rights: "No, it does not contain, show, or access third-party
  content".
- **Age Rating** → Edit: answer **None** or **No** to everything (no violence,
  no gambling, no unrestricted web access, no messaging or chat with strangers,
  no public user-generated content: notes are shared only with people the user
  invites by email). The result should be **4+**.

**Pricing and Availability**: price **Free** (USD 0). Availability: all
countries, or start with the EU, UK, US and Switzerland.

**App Privacy**:

1. Privacy Policy URL: https://sortmemo.com/legal/privacy.html
2. **Get Started** → "Do you or your third-party partners collect data from
   this app?" → **Yes**.
3. Tick exactly these data types, then answer for each: **linked to the
   user: Yes**, **used for tracking: No**, and the purpose shown:

| Section | Data type | Purpose to tick | What it is |
|---|---|---|---|
| Contact Info | Name | App Functionality | The account's name |
| Contact Info | Email Address | App Functionality | Logging in, password reset |
| User Content | Photos or Videos | App Functionality | Photos added to notes |
| User Content | Customer Support | App Functionality | "Send feedback" messages |
| User Content | Other User Content | App Functionality | Notes, lists, dates, groups, labels, shares |
| Identifiers | User ID | App Functionality | The account number |
| Identifiers | Device ID | Analytics | A random number made by the app for A/B tests (not the advertising ID) |
| Usage Data | Product Interaction | Analytics, App Functionality | "Opened the app", "wrote a note": never the text |
| Diagnostics | Other Diagnostic Data | App Functionality | Server error reports (Sentry) with the account number, never note text or email |

Do **not** tick: Location, Contacts, Health, Financial Info, Sensitive Info,
Browsing or Search History, Purchases (the app sells nothing), Audio Data
(dictation keeps only the text; SortMemo never receives the sound), Crash Data
(the app sends no crash reports), Advertising Data. Then **Publish**.

These answers match the app's privacy manifest
(ios/RecordAI.swiftpm/PrivacyInfo.xcprivacy). If the app ever collects
something new, both must change together.

**The version page** ("1.0 Prepare for Submission", top of the left menu):

1. Version number: **1.0.0**.
2. **Screenshots**: see A8.
3. Promotional text (optional), Description, Keywords, Support URL
   (https://sortmemo.com/legal/support.html), Marketing URL (https://sortmemo.com):
   paste from STORE.md. Switch the language at the top right to paste Italian.
4. **What's New**: hidden for the first version; from 1.0.1 on, paste from STORE.md.
5. **Build**: **+** → choose the build you uploaded in A5.
6. Copyright: `2026 <your name or business>`.
7. **App Review Information**: Sign-in required: **Yes**. User name and
   password: the demo account from "Before you start", step 4. Contact: your
   name, phone and email. **Notes** (paste and adjust):

   > SortMemo is a notes app: the AI gives each note a title, a group, a
   > priority and its date. Please log in with the demo account above; it has
   > Premium and example notes. Try: type "Dentist Friday 3pm" and save it
   > (sorted within seconds); start lines with "- " for a checklist; tap the
   > School switch to see a group per child; open a note to set labels, the
   > date or the world. Account deletion: tap the initials (top right) →
   > Account → Delete my account. The app sells nothing; there are no in-app
   > purchases in this version. Sign-up is invite-only during our alpha;
   > please use the demo account above.

8. Version Release: **Manually release this version** (so you choose the day).

**EU trader status** 🔐: App Store Connect → **Business** (or your account
name → **Agreements, Tax, and Banking**) → **Digital Services Act** → declare
that you are a trader and enter the address, phone and email to show.

Also sign the **Free Apps** agreement there if App Store Connect asks
(the Paid Apps agreement with bank and tax details is only needed if the apps
ever sell something).

### A8. Screenshots for the App Store 🛠

Apple needs at least one set for a **6.9-inch iPhone: 1320 × 2868 pixels**
(portrait). It shrinks them for smaller iPhones. A second set for **6.5-inch:
1284 × 2778** (iPhone 14 Plus) is optional but recommended. 3 to 5 pictures
per set is plenty; up to 10 are allowed.

1. In Xcode, at the top where the device is chosen, pick a **Pro Max**
   simulator (for example "iPhone 17 Pro Max": 6.9-inch, 1320 × 2868). For
   6.5-inch pick an **iPhone 14 Plus** (1284 × 2778); add it under Window →
   Devices and Simulators → Simulators → **+** if it isn't listed.
2. Press **▶ (Run)**. The app opens in the Simulator. Log in with the demo
   account.
3. Show something worth seeing, then press **⌘S** (Simulator → File → Save
   Screen). The picture is saved on your Desktop at the exact size Apple wants.
4. Good pictures: (1) notes sorted by priority, (2) a note open with its
   date, labels and list, (3) the School world with a group per child,
   (4) sharing with your partner, (5) Hear today or "Turn into tasks" on a
   school letter.
5. Drag the files into App Store Connect → the version page → **iPhone 6.9"
   Display** (and **6.5"**).

Only the real app may be shown (no pictures of features it doesn't have), and
no other company's phone frames or logos.

### A9. Send it to Apple 🔐

1. On the version page, top right: **Add for Review** → **Submit to App Review**.
2. Status goes to "Waiting for Review", then "In Review" (usually within
   one or two days). Apple emails you at each step.
3. If Apple has a question or a problem, it is under **App Review** →
   the message in **Resolution Center**. Answer there, in plain words. If a
   change in the app is needed, a helper fixes it, you upload a new build
   (A5, build number + 1), choose it on the version page and submit again.
4. When it says **Pending Developer Release**, click **Release This Version**.
   It is in the App Store within a few hours.

---

## Part B: Google Play (Android)

### B1. Create the Google Play developer account 🔐

1. Go to play.google.com/console and sign in with the Google account that
   should own SortMemo. A dedicated one is best, and it can't be changed
   later: a free Google account created with nina@sortmemo.com (on
   accounts.google.com choose **Create account** → **Use your existing
   email**) is enough; no Google Workspace needed.
2. Choose **Yourself** (personal account) or **An organization or business**.
   An organization needs a **D-U-N-S number** (the same as for Apple; 1 to 2
   weeks to get one if you don't have it yet) and the
   organization's website and phone; a personal account needs only your ID.
3. Pay the **$25** one-time fee, verify your identity (ID document) and your
   phone number. This can take a few days.
4. **You need a real Android phone** (your own or a borrowed one). Google asks
   new developer accounts to verify that they have one, by signing in to the
   **Play Console** app on it, and you need a phone to try the app before
   releasing it (B6). An emulator on the Mac doesn't count for the
   verification.

**Important for personal accounts made after November 2023:** before an app
can go public, it must run a **closed test with at least 12 testers who stay
opted in for at least 14 days in a row**. Organization accounts don't have
this rule. Start finding 12 testers (family, friends, colleagues with an
Android phone and a Google account) now.

### B2. Make the upload key 🔐 (a helper can make it with you, on your Mac)

Google signs the app for the Play Store itself (**Play App Signing**). You
sign each upload with your own **upload key**, a small file (`.jks`) with a
password. Make it once:

1. Install **Android Studio** (developer.android.com/studio; large, use
   Wi-Fi) and open it once.
2. Open **Terminal** and paste (one line):

   ```bash
   mkdir -p ~/Documents/SortMemo-keys && "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v -keystore ~/Documents/SortMemo-keys/sortmemo-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

3. It asks for a password (type it twice; nothing shows while you type), then
   your name, organization, city, country code (`IT`). Answer, then `yes`.
   The key file is in the PKCS12 format, so the **key password is the same as
   the key store password**: wherever a "key password" is asked (B3), type
   that same password.
4. **Keep it safe:** save the file `sortmemo-upload.jks`, the password and the
   alias (`upload`) in your password manager (1Password, Bitwarden, or a
   secure note in Apple Passwords), and a copy of the file on a USB stick kept
   at home. **Never** put the file or the password in the repository, in an
   email or in a chat. (The repository ignores `.jks` and `.keystore` files,
   in the android folder and at the top level, to prevent accidents.)

If the upload key is ever lost, Play Console can give you a new one
(Setup → App integrity → **Request upload key reset**): annoying, not fatal.

### B3. Build the signed app bundle (.aab) 🛠

Pick one of three ways. Each makes the file to upload: an **Android App
Bundle** (`.aab`).

**Way 1: Android Studio (easiest on your Mac)**

1. Android Studio → **File** → **Open…** → the project folder → **android** →
   Open. Wait until the bottom bar stops working ("Gradle sync").
2. Menu **Build** → **Generate Signed App Bundle or APK…** → **Android App
   Bundle** → Next.
3. Key store path: **Choose existing…** → `~/Documents/SortMemo-keys/sortmemo-upload.jks`.
   Key store password, Key alias `upload`, Key password (the same as the key
   store password). Next.
4. Build variant **release** → **Create**. When it finishes, click **locate**:
   the file is `android/app/release/app-release.aab`.

**Way 2: GitHub (no Android Studio needed), 🔐 to set up once**

1. In Terminal: `base64 -i ~/Documents/SortMemo-keys/sortmemo-upload.jks | pbcopy`
   (this copies the key file as text).
2. On github.com → the record.ai repository → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**, four times:
   - `SORTMEMO_UPLOAD_KEYSTORE_BASE64`: paste (⌘V)
   - `SORTMEMO_UPLOAD_STORE_PASSWORD`: the key store password
   - `SORTMEMO_UPLOAD_KEY_ALIAS`: `upload`
   - `SORTMEMO_UPLOAD_KEY_PASSWORD`: the key password (the same as the key
     store password)
3. Then, each time: **Actions** → **Android release** → **Run workflow**. When
   it is green, download **sortmemo-android-aab** under **Artifacts** and
   unzip it: inside is `app-release.aab`.

**Way 3: Terminal (for a helper)**

Put the four values in `~/.gradle/gradle.properties` (on the Mac, never in the
repository):

```properties
SORTMEMO_UPLOAD_STORE_FILE=/Users/<you>/Documents/SortMemo-keys/sortmemo-upload.jks
SORTMEMO_UPLOAD_STORE_PASSWORD=...
SORTMEMO_UPLOAD_KEY_ALIAS=upload
SORTMEMO_UPLOAD_KEY_PASSWORD=...
```

then run `cd android && ./gradlew :app:bundleRelease`. The file is
`android/app/build/outputs/bundle/release/app-release.aab`.

Without the key, the build is signed with a test key that Google Play
refuses, so a wrong upload can't happen by accident.

For every later upload, a helper raises `versionCode` by 1 in
android/app/build.gradle.kts (2, 3, …) and `versionName` for each new release
("1.0.1").

### B4. Create the app in Play Console 🔐

1. Play Console → **Create app**.
2. App name: **SortMemo: AI Notes & Lists**. Default language: **English (United
   States) – en-US**. App or game: **App**. Free or paid: **Free**. Tick the
   two declarations → **Create app**.
3. The package name is set by the first upload (B6): `com.ninakozinska.recordai`.

### B5. "Set up your app": the forms 🔐

On the app's **Dashboard**, under "Set up your app", open each task:

- **Privacy policy**: https://sortmemo.com/legal/privacy.html
- **App access**: "All or some functionality is restricted" → **Add
  instructions**: name "Demo account", the demo email and password, and the
  same notes as for Apple (A7, App Review Information).
- **Ads**: "No, my app does not contain ads".
- **Advertising ID**: "Does your app use advertising ID?" **No**.
- **Content rating**: Start questionnaire → your email → Category **All other
  app types** (or "Utility, productivity, communication…"). Answer **No** to
  violence, sexuality, language, controlled substances, gambling and
  "unrestricted internet". To "Can users interact or exchange content?"
  answer **Yes** (people can share notes with people they invite by email)
  and explain that only invited people see shared notes; to "shares
  location" **No**; to "digital purchases" **No**. Save → **Submit**. Expect
  "Everyone" or "PEGI 3/USK 0" with "Users Interact".
- **Target audience**: **18 and over** (you may add 16–17: the privacy policy
  allows 16+). Do not select ages under 13. "Could your store listing
  unintentionally appeal to children?" **No**.
- **News app**: No. **Government app**: No.
  **Financial features**: none. **Health**: none.
- **Data safety** (the answers below).
- **App category**: **Productivity**. Contact details: your support email,
  phone (optional), website https://sortmemo.com.
- **Store listing**: paste the short and full description from STORE.md; app
  icon `docs/store/play-icon-512.png`; feature graphic
  `docs/store/play-feature-graphic-1024x500.png`; phone screenshots (B7).
  Add a translation for **Italian** (and others from STORE.md) with **Manage
  translations**.
- 🔐 **Trader status** (Play Console → Settings → Developer account →
  **Account details**): if you monetize, declare trader and check the address
  and phone shown in the EU.

**Data safety answers:**

1. "Does your app collect or share any of the required user data types?"
   **Yes**. "Is all of the user data collected by your app encrypted in
   transit?" **Yes**: the app talks to sortmemo.com only over HTTPS. (The
   app's allowance for plain http is only for people who connect it to a
   server they run themselves on their home network; sortmemo.com is always
   reached over HTTPS.) "Which of the following methods of account creation does
   your app support?" **Username and password** (add "OAuth" only if you turn
   on Continue with Google etc.). Account deletion link:
   **https://sortmemo.com/legal/delete-account.html**. "Do you provide a way
   for users to request that some or all of their data is deleted, without
   requiring them to delete their account?" **Yes** (they can delete notes and
   photos in the app).
2. Data types, all **Collected: yes, Shared: no** (Fly.io, Anthropic, Resend
   and Sentry work for SortMemo as processors, which Google does not count as
   sharing), **not processed ephemerally**:

| Category | Type | Required or optional | Purposes |
|---|---|---|---|
| Personal info | Name | Required | App functionality, Account management |
| Personal info | Email address | Required | App functionality, Account management, Developer communications (password reset) |
| Personal info | User IDs | Required | App functionality, Account management |
| Photos and videos | Photos | Optional | App functionality |
| App activity | App interactions | Required | Analytics, App functionality |
| App activity | Other user-generated content (notes, lists, feedback) | Required | App functionality |
| App info and performance | Diagnostics (server error reports) | Required | App functionality |
| Device or other IDs | Device or other IDs (a random id made by the app) | Required | Analytics |

Not collected: location, financial info, health, messages, audio (dictation
keeps only the text), files and docs, contacts, web browsing, calendar
(calendars are connected only in the web app, never through the Android app;
Apple's privacy answers in A7 leave them out for the same reason).

### B6. Test, then go public 🔐

1. **Internal testing** (optional but quick, no review): Play Console →
   **Test and release** → **Testing** → **Internal testing** → **Create new
   release** → accept **Play App Signing** when asked (Google keeps the app
   signing key; you keep the upload key) → upload `app-release.aab` →
   release name `1.0.0` → **Next** → **Save and publish**. Add testers by
   email under **Testers**; they open the link on their phone.
2. **Closed testing** (required for new personal accounts): **Closed testing**
   → **Create track** (or use "Alpha") → **Testers**: create an email list with
   **at least 12** testers → create a release with the same `.aab` (or a newer
   one) → **Send for review**. Once approved, send the testers the opt-in link.
   They must **accept the invitation and keep the app** for **14 days in a
   row**. Ask them to open it now and then and to send feedback in the app.
3. After 14 days, the Dashboard offers **Apply for production**. Answer the
   questions about your test (how many testers, what you learned, what you
   changed) honestly and in plain words. Google answers within about a week.
4. **Production** → **Create new release** → choose the tested build → release
   notes from STORE.md ("What's new") → **Next** → **Start rollout to
   Production**. The first review takes from a few hours to a few days.

### B7. Screenshots and pictures for Google Play 🛠

- **App icon**: `docs/store/play-icon-512.png` (512 × 512, ready).
- **Feature graphic**: `docs/store/play-feature-graphic-1024x500.png` (1024 × 500, ready).
- **Phone screenshots**: at least 2 (4 to 8 is better), PNG or JPEG, and the
  long side may be at most twice the short side. **1080 × 1920** is safe.
  1. Android Studio → **Device Manager** (right edge) → **+** → **Create
     Virtual Device** → **Pixel 2** (1080 × 1920) → a recent system image →
     Finish → ▶ to start it.
  2. With the android project open, press **▶ Run 'app'**. Log in with the
     demo account.
  3. Click the **camera icon** in the emulator's side bar to save a screenshot
     (on your Desktop). Take the same five pictures as for Apple.
  4. Upload them under **Store listing** → **Phone screenshots**.

`node scripts/make-store-icons.mjs` makes the icon and the feature graphic
again if the logo changes.

---

## Part C: what reviewers often reject, and how SortMemo handles it

| What they check | How SortMemo handles it |
|---|---|
| **Reviewers can't log in or the app looks empty** (Apple 2.1, Google "App access") | The demo account has Premium and example notes; the login is in the review notes. Check that sortmemo.com is up on review days (the Uptime check on GitHub tells you). |
| **Account deletion inside the app** (Apple 5.1.1(v), Google account deletion) | Initials (top right) → Account → **Delete my account**: deletes the account, notes, photos and backups. Google also gets the web page https://sortmemo.com/legal/delete-account.html. |
| **Privacy policy** (both) | Linked in the store and inside the app: on the login screen and under Account (Privacy · Terms · Help). It must be finished: no "Draft", no [brackets]. |
| **Sign in with Apple** (Apple 4.8) | Only needed if the app offers other sign-ins such as Google or Facebook. sortmemo.com has only email and password today, so nothing to do. If you turn on "Continue with Google" (docs/SOCIAL_LOGIN.md), turn on **Apple** too before the next iPhone review: the apps show whatever the server offers. |
| **Payments** (Apple 3.1.1, 3.1.3; Google Payments policy) | The apps sell nothing and have no prices, buy buttons or links to pay. Premium bought on the web works in the apps. See "Before you start", point 5, if Apple asks for in-app purchase. |
| **Permission texts** (Apple 5.1.1) | Camera, microphone, speech recognition, photos and local network each say, naming SortMemo, why and when they are used. |
| **Privacy answers match the app** (Apple App Privacy, Google Data safety) | The answers above match what the server stores (docs and privacy.html) and Apple's privacy manifest in the app. |
| **Misleading store page** (Apple 2.3, Google Metadata) | The texts in STORE.md describe only what the apps do: reminders and the morning briefing are left out until the phones send notifications. No "best", "#1" or other apps' names. |
| **Crashes and dead buttons** (Apple 2.1, Google Broken functionality) | Try the TestFlight / internal test build first (A6, B6). Apple also opens iPhone apps on an iPad: try it once in an iPad simulator. |
| **Minimum functionality** (Apple 4.2) | A native app: offline notes, dictation, camera, live sync, sharing, Siri "Hear today". |
| **Content shared by users** (Apple 1.2) | Notes are shared only with people the owner invites by email; there is no public feed or chat with strangers. |
| **Target API level** (Google) | The Android app targets Android 16 (API 36), the level Google Play currently requires for new apps and updates. Google raises the requirement each August: if Play Console warns that a newer target is needed, a helper raises `targetSdk` (and `compileSdk`) in android/app/build.gradle.kts. |
| **12 testers for 14 days** (Google, new personal accounts) | Plan it from day one (B1, B6). |

---

## Part D: later updates

1. 🛠 A helper changes the app, raises the numbers (iPhone `displayVersion` and
   `bundleVersion` in ios/RecordAI.swiftpm/Package.swift; Android `versionName`
   and `versionCode` in android/app/build.gradle.kts) and writes a "What's new"
   text in STORE.md.
2. 🔐 iPhone: A5 (archive and upload), then in App Store Connect click **+**
   next to "iOS App" to make version 1.0.1, paste "What's New", choose the build,
   submit (A9).
3. 🔐 Android: B3 (build), then Play Console → **Production** → **Create new
   release** → upload → release notes → rollout. No 14-day test after the
   first time.

---

## Final checklist

Before you submit:

- [ ] 🔐 Privacy policy, terms, delete-account and support pages finished (no "Draft", no [brackets]; the list is in "Before you start", point 1)
- [ ] 🔐 Test email sent to support@sortmemo.com, and it arrived
- [ ] 🔐 Sign-up stays invite-only; review notes say "Sign-up is invite-only during our alpha; please use the demo account above." (optional: an "App Review" invite code)
- [ ] 🔐 Demo account made, logs in, shows example notes and Premium (change its password after the review)
- [ ] 🔐 Decided: keep `com.ninakozinska.recordai` (or changed it **before** the first upload)
- [ ] 🔐 Decided what to answer if Apple asks for in-app purchase
- [ ] 🔐 EU trader details entered (Apple and Google)

App Store:

- [ ] 🔐 Apple Developer Program active
- [ ] 🔐 Bundle ID registered, app created in App Store Connect
- [ ] 🔐 Build uploaded and tried in TestFlight; privacy manifest checked inside the app (A5)
- [ ] 🔐 App Information, age rating 4+, price Free, App Privacy published
- [ ] 🛠 Screenshots 6.9" (and 6.5") uploaded
- [ ] 🔐 Description, keywords, support URL, copyright, review notes with demo account
- [ ] 🔐 Submitted; released after approval

Google Play:

- [ ] 🔐 Developer account verified (with a real Android phone)
- [ ] 🔐 Upload key made and saved in two safe places
- [ ] 🛠 Signed `.aab` built (Android Studio, GitHub or Terminal)
- [ ] 🔐 App created; all "Set up your app" tasks done, Data safety submitted
- [ ] 🛠 Icon, feature graphic and 4+ phone screenshots uploaded
- [ ] 🔐 Closed test with 12+ testers for 14 days (personal accounts)
- [ ] 🔐 Applied for production; released

---

## Appendix: what each app can do

The full table, before and after the store-release work, is in
[PARITY.md](PARITY.md). In short, the iPhone and Android apps now do what the
web app does for everyday use: notes, dictation, photos, lists, the Work /
Family / School worlds with a group per child and "Which child?", choosing a
note's world, labels (Premium) with filters and `label:` search, sharing a
note, a group or all of School, sending a note by email or WhatsApp, note
history, reading aloud and Hear today, suggested to-dos, backups, feedback,
and deleting the account.

Still only on the web, on purpose: notifications for reminders and the
morning briefing (they need Apple's and Google's push keys first), buying
Premium, connecting calendars and AI assistants, downloading all notes, and
the owner's dashboard.
