// Sending email (password reset links). Works with Resend (resend.com) when
// RESEND_API_KEY and MAIL_FROM are set. Without them, nothing is sent: the
// message is written to the server log instead, so the owner can still pass
// a reset link on by hand (fly logs).

export function mailer({ env = process.env, fetch = globalThis.fetch, log = console } = {}) {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  // Where replies go, e.g. support@your-domain (a mailbox you read); optional.
  const replyTo = env.MAIL_REPLY_TO;
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
        body: JSON.stringify({ from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      if (!res.ok) {
        log.error(`[mail] Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    },
  };
}

// The password reset email, in the person's language.
const RESET = {
  en: ['Reset your SortNotes password', (n, l) => `Hi ${n},\n\nTo choose a new password, open this link within one hour:\n${l}\n\nIf you didn't ask for this, ignore this email: your password stays the same.\n\nSortNotes`],
  it: ['Reimposta la password di SortNotes', (n, l) => `Ciao ${n},\n\nper scegliere una nuova password, apri questo link entro un'ora:\n${l}\n\nSe non l'hai chiesto tu, ignora questa email: la tua password resta la stessa.\n\nSortNotes`],
  fr: ['Réinitialisez votre mot de passe SortNotes', (n, l) => `Bonjour ${n},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien dans l'heure :\n${l}\n\nSi vous n'avez rien demandé, ignorez cet e-mail : votre mot de passe ne change pas.\n\nSortNotes`],
  es: ['Restablece tu contraseña de SortNotes', (n, l) => `Hola, ${n}:\n\nPara elegir una contraseña nueva, abre este enlace antes de una hora:\n${l}\n\nSi no lo has pedido tú, ignora este email: tu contraseña sigue igual.\n\nSortNotes`],
  pt: ['Repor a palavra-passe do SortNotes', (n, l) => `Olá ${n},\n\nPara escolher uma nova palavra-passe, abra este link no prazo de uma hora:\n${l}\n\nSe não pediu isto, ignore este email: a sua palavra-passe continua igual.\n\nSortNotes`],
  de: ['Setze dein SortNotes-Passwort zurück', (n, l) => `Hallo ${n},\n\num ein neues Passwort zu wählen, öffne diesen Link innerhalb einer Stunde:\n${l}\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail: Dein Passwort bleibt gleich.\n\nSortNotes`],
  pl: ['Zresetuj hasło do SortNotes', (n, l) => `Cześć ${n},\n\naby ustawić nowe hasło, otwórz ten link w ciągu godziny:\n${l}\n\nJeśli to nie ty, zignoruj tę wiadomość: hasło się nie zmieni.\n\nSortNotes`],
};

/** The language for an email: the account's, else the browser's (Accept-Language), else English. */
export function mailLanguage(accountLang, acceptLanguage = '') {
  if (RESET[accountLang]) return accountLang;
  for (const part of String(acceptLanguage).split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (RESET[code]) return code;
  }
  return 'en';
}

export function resetEmail(lang, { name, link }) {
  const [subject, text] = RESET[lang] || RESET.en;
  return { subject, text: text(name, link) };
}
