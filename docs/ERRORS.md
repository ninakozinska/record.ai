# Error reports (Sentry)

When the server meets an error it did not expect, it sends a short report to
[Sentry](https://sentry.io) (free plan, EU region). A report holds where in the
code it happened, the kind of request (the route, without query strings) and
the account id. Never the text of a note, an email address or a password.

## Set it up

1. Make a free Sentry account (EU data region) and a Node.js project.
2. Copy the project's DSN: Settings → Projects → your project → Client Keys (DSN).
3. Save it on the server, typing the start of the command and pasting the DSN after the `=`:

   ```
   fly secrets set SENTRY_DSN=https://<key>@<org>.ingest.de.sentry.io/<project>
   ```

   Quotes, spaces or a line break around the DSN are fine: the server picks
   the DSN out of whatever was pasted.
4. On the owner's dashboard, press **Send a test error**. It should say
   "✓ Test error sent", and the error appears in Sentry → Issues within a minute.
   If it says the saved value is not a Sentry DSN, copy it again (step 2).

Without `SENTRY_DSN`, errors are only written to the server log (`fly logs`).

## Whose account was it?

Sentry shows only an account id (like `a4bc1314-…`). Paste it into
**Find an account** on the owner's dashboard to see the name, email, plan and
when the account was last active. The name and email stay on the server.

## Limits

At most 30 reports a minute are sent, so a broken loop cannot flood Sentry.
The same error happening many times arrives as one issue with a count.
