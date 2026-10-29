// Sending email (password reset links). Works with Resend (resend.com) when
// RESEND_API_KEY and MAIL_FROM are set. Without them, nothing is sent: the
// message is written to the server log instead, so the owner can still pass
// a reset link on by hand (fly logs).

export function mailer({ env = process.env, fetch = globalThis.fetch, log = console } = {}) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  return {
    configured: !!(key && from),
    async send({ to, subject, text }) {
      if (!key || !from) {
        log.log(`[mail] not sent (no RESEND_API_KEY / MAIL_FROM). To ${to}: ${subject}\n${text}`);
        return false;
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) {
        log.error(`[mail] Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    },
  };
}
