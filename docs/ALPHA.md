# Alpha test: 25 people, invite only

The plan, the invite messages and the tester list are in the Claude doc
"record.ai: Alpha test". This file is the technical part.

## Switch on invite-only (5 minutes)

1. Make sure open sign-up is off. In Terminal: `fly secrets list`. If `ALLOW_SIGNUP`
   is there, remove it: `fly secrets unset ALLOW_SIGNUP` (open sign-up wins over invites).
2. Open record.ai → your initials → **📊 Dashboard** → **🎟 Alpha invites**.
3. Paste the 25 names, one per line, keep **Family** as the plan, and tap
   **Make invite links**. From that moment new accounts need an invite.
4. **Copy** a link and send it to that person, or **Copy all open links**.

Each link works once. The dashboard shows who joined and when; **Withdraw** stops
a link that was not used. Testers keep their Family plan until you change it in
"People and plans".

## What a tester sees

The link opens record.ai on the sign-up form with the code already filled in.
They choose a name, email and password (or "Continue with Google" once that is
switched on), and land in the app with the welcome tour.
