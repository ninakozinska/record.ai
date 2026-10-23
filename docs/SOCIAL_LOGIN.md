# Sign in with Google, Apple, Microsoft, Facebook, LinkedIn, X and GitHub

record.ai can show **"Continue with …"** buttons in the web app, the iPhone app and the Android app. Each button appears once you've registered record.ai with that company and put two keys in the settings. You can turn on just one provider, or all of them.

All of these registrations are **free**, except Apple: Sign in with Apple needs the paid Apple Developer Program ($99/year).

## Before you start: your server needs a fixed HTTPS address

Every provider asks: *"After someone signs in, which address should I send them back to?"* That address must:

- start with **`https://`** (Google also accepts `http://localhost` for testing on the Mac itself), and
- stay the same. If the address changes, sign-in stops working until you update it with each provider.

Good options:

- **Tailscale** (free): your `https://….ts.net` address. It only works on your own devices that have Tailscale.
- **Online hosting** with your own domain, e.g. `https://notes.yourname.com`. Do this before inviting other people.

Write your address into the settings file (`.env` in the record.ai folder):

```
PUBLIC_URL=https://your-mac.tail1234.ts.net
```

Below, **`<address>`** means this address. For each provider, the "redirect URL" or "callback URL" to enter is:

| Provider | Redirect URL to enter |
|---|---|
| Google | `<address>/api/auth/oauth/google/callback` |
| Apple | `<address>/api/auth/oauth/apple/callback` |
| Microsoft | `<address>/api/auth/oauth/microsoft/callback` |
| Facebook | `<address>/api/auth/oauth/facebook/callback` |
| LinkedIn | `<address>/api/auth/oauth/linkedin/callback` |
| X (Twitter) | `<address>/api/auth/oauth/x/callback` |
| GitHub | `<address>/api/auth/oauth/github/callback` |

After adding keys to `.env`, **restart record.ai**. The server's start-up message lists the sign-in options that are on.

## Google

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in. Create a project, e.g. "record.ai".
2. Open **Google Auth Platform** (or **APIs & Services → OAuth consent screen**) and fill in the app name and your email. Choose **External** users.
3. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**) and choose **Web application**.
4. Under **Authorized redirect URIs**, add the Google redirect URL from the table. Click **Create**.
5. Copy the **Client ID** and **Client secret** into `.env`:
   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```
6. While the app is in **Testing**, only the Google accounts you add as **test users** can sign in. When you're ready for everyone, choose **Publish app**.

## Apple (needs the paid Apple Developer Program)

1. At [developer.apple.com/account](https://developer.apple.com/account), go to **Certificates, Identifiers & Profiles**.
2. **Identifiers → +** → **Services IDs**. Give it a description and an identifier such as `com.yourname.recordai.web`. Save it.
3. Open the new Services ID, tick **Sign in with Apple**, and click **Configure**. Pick your app's main App ID. Under **Domains**, add your address without `https://`. Under **Return URLs**, add the Apple redirect URL from the table.
4. **Keys → +**. Name it, tick **Sign in with Apple**, configure it with the same App ID, and download the `.p8` file. Apple lets you download it **only once**. Note the **Key ID**.
5. Your **Team ID** is shown at the top right of the developer site.
6. Put the `.p8` file in the record.ai folder, then add to `.env`:
   ```
   APPLE_CLIENT_ID=com.yourname.recordai.web
   APPLE_TEAM_ID=…
   APPLE_KEY_ID=…
   APPLE_PRIVATE_KEY_FILE=AuthKey_XXXXXXXXXX.p8
   ```

The App Store requires Sign in with Apple in any iPhone app that offers Google, Facebook and the like. So turn on Apple before publishing the iPhone app.

## Microsoft (Outlook, Hotmail, work and school accounts)

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** → **New registration**.
2. Name it. Under **Supported account types**, choose **Accounts in any organizational directory and personal Microsoft accounts**.
3. Under **Redirect URI**, choose **Web** and enter the Microsoft redirect URL from the table. Click **Register**.
4. Copy the **Application (client) ID**. Then go to **Certificates & secrets → New client secret** and copy its **Value** (not the Secret ID).
   ```
   MICROSOFT_CLIENT_ID=…
   MICROSOFT_CLIENT_SECRET=…
   ```
   Client secrets expire (at most after 2 years). Put a reminder in your calendar.

## Facebook

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**.
2. Choose the use case **Authenticate and request data from users with Facebook Login**.
3. In **Facebook Login → Settings**, add the Facebook redirect URL to **Valid OAuth Redirect URIs**. Save.
4. In **App settings → Basic**, copy the **App ID** and **App secret**:
   ```
   FACEBOOK_CLIENT_ID=…
   FACEBOOK_CLIENT_SECRET=…
   ```
5. Until the app is **Live**, only you and people you add under **App roles** can sign in. Going live needs a privacy policy link.

## LinkedIn

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) → **Create app**. LinkedIn asks for a company page. You can create a simple page for record.ai.
2. On the **Products** tab, add **Sign In with LinkedIn using OpenID Connect**.
3. On the **Auth** tab, add the LinkedIn redirect URL under **Authorized redirect URLs**, then copy the **Client ID** and **Primary Client Secret**:
   ```
   LINKEDIN_CLIENT_ID=…
   LINKEDIN_CLIENT_SECRET=…
   ```

## X (Twitter)

1. Go to [developer.x.com](https://developer.x.com) → **Developer Portal**. The free tier is enough for sign-in.
2. Open your app → **User authentication settings → Set up**.
3. Choose **OAuth 2.0**, with app type **Web App, Automated App or Bot**.
4. Add the X redirect URL as the **Callback URI**, plus your address as the **Website URL**. Save.
5. Copy the **OAuth 2.0 Client ID and Client Secret** (under **Keys and tokens**):
   ```
   X_CLIENT_ID=…
   X_CLIENT_SECRET=…
   ```

X doesn't share email addresses, so an account made with X has no email. That's fine: people log in with the X button. In the web app, they can add Google or a password under their initials → **Sign-in options**.

## GitHub

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**.
2. **Homepage URL** = your address. **Authorization callback URL** = the GitHub redirect URL from the table.
3. Copy the **Client ID**, then **Generate a new client secret**:
   ```
   GITHUB_CLIENT_ID=…
   GITHUB_CLIENT_SECRET=…
   ```

## How accounts are matched

- **The same person, any button.** If Google, Apple, LinkedIn or GitHub confirms an email that already has a record.ai account, that account is used. Signing in with Google doesn't create a second account.
- **No takeovers.** Microsoft, Facebook and X don't guarantee that an email really belongs to the person. If their email matches an existing account, record.ai asks them to log in the usual way first, then connect the provider under their initials → **Sign-in options**.
- **New accounts follow the same rules as email sign-up.** The very first account is always allowed. After that, someone new needs `ALLOW_SIGNUP=true` or the invite code (`SIGNUP_CODE`). With an invite code, they choose "Create an account", type the code, then tap the provider's button.
- **Connecting more providers** happens in the web app: tap your initials → **Sign-in options → Connect**. You can disconnect any of them, as long as one way to log in is left. An account made with a provider can also set a password there.

## Security

- **Phone apps:** the provider's page opens in the system browser (on iPhone, Apple's secure sign-in sheet). It comes back to the app with a one-time code that expires in 2 minutes. The code only works together with a secret that never leaves the phone, so another app that catches it can't use it.
- **Tamper protection:** every sign-in uses a random `state` value, and PKCE where the provider supports it. A sign-in left unfinished for more than 10 minutes expires.
- **What record.ai keeps:** only the provider's account number for you and your email. It never sees or stores your Google, Apple or other password, and it doesn't keep the providers' access tokens.
