// A record.ai server whose "Google" is fake, for testing the phone apps'
// "Continue with Google" without a Google account. Usage:
//   PORT=4000 DATA_DIR=/tmp/x node test/fixtures/fake-google-server.mjs
// The fake Google signs in sub "google-nina" / nina@example.com (verified).
import { createApp } from '../../server/app.js';

const fakeGoogle = async (url) => {
  const ok = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (String(url) === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'fake' });
  return ok({ sub: 'google-nina', email: 'nina@example.com', email_verified: true, name: 'Nina from Google' });
};

const { app } = createApp({
  dataDir: process.env.DATA_DIR,
  oauth: { env: { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test' }, fetch: fakeGoogle },
});
app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready'));
