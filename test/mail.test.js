// Sending email through Resend: the sender, and where replies go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailer } from '../server/mail.js';

const capture = () => {
  const sent = [];
  const fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  return { sent, fetch };
};

test('replies go to MAIL_REPLY_TO when it is set', async () => {
  const { sent, fetch } = capture();
  const m = mailer({ env: { RESEND_API_KEY: 'k', MAIL_FROM: 'SortNotes <hello@example.com>', MAIL_REPLY_TO: 'support@example.com' }, fetch });
  assert.equal(await m.send({ to: 'a@example.com', subject: 's', text: 't' }), true);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.equal(sent[0].body.reply_to, 'support@example.com');
  assert.equal(sent[0].body.from, 'SortNotes <hello@example.com>');
});

test('without MAIL_REPLY_TO no reply address is sent; without a key nothing is sent', async () => {
  const { sent, fetch } = capture();
  await mailer({ env: { RESEND_API_KEY: 'k', MAIL_FROM: 'hello@example.com' }, fetch }).send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal('reply_to' in sent[0].body, false);
  const quiet = { log() {} };
  assert.equal(await mailer({ env: {}, fetch, log: quiet }).send({ to: 'a@example.com', subject: 's', text: 't' }), false);
  assert.equal(sent.length, 1);
});
