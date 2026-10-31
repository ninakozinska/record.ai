# Who processes personal data for record.ai (GDPR)

The record of processors that the GDPR asks for (Article 28 and 30), and what is
still to sign. The privacy policy (public/legal/privacy.html) names the same list.
Items in [brackets] are for you to check or do; each takes a few minutes in the
service's dashboard.

| Processor | What it does | Personal data | Where | Agreement (DPA) |
|---|---|---|---|---|
| Fly.io | Runs the server, stores the database and photos | Everything in the app | Frankfurt, Germany (EU); company in the US | [Accept Fly.io's DPA in the dashboard; note the US transfer safeguards (Standard Contractual Clauses)] |
| Anthropic | The AI that sorts notes | Text and photos of notes being sorted, never names or emails | US | [Part of Anthropic's Commercial Terms; check data retention and that inputs are not used for training; note the SCCs] |
| Stripe | Web payments | Name, email, plan, card (card stays with Stripe) | EU and US | [Stripe's DPA is part of its services agreement; confirm] |
| Resend | Sends password reset emails | Email address, the email | US (EU region possible) | [Accept Resend's DPA; choose the EU region if offered] |
| Sentry | Server error reports | Account number, where the error happened | EU region possible | [Choose the EU region when creating the account; accept the DPA] |
| Apple, Google, Mozilla push services | Deliver notifications | A device address; the text is encrypted end to end | Worldwide | [Not processors of content (encrypted); mention in the policy, as done] |

**Not processors** (the person connects their own account, and record.ai acts on
their instruction): Google Calendar, Microsoft Outlook, Calendly, iCloud, and the
"Continue with Google / Apple / GitHub" sign-ins.

**Later, when used:** Cloudflare R2 (off-site backup copy, photos at scale),
UptimeRobot (only pings the health address, no personal data), PostHog (if chosen).

## What to keep on file

- A copy or link of each signed DPA, with the date.
- This list, updated when a service is added.
- For transfers outside the EU: which safeguard each one uses (usually the EU Standard Contractual Clauses), in the privacy policy.
