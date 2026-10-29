// Paying for Premium through Stripe: Checkout, the signed webhook, the portal,
// and nothing sold (or charged) when it shouldn't be. Stripe itself is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { start } from './helpers.js';
import { billing } from '../server/billing.js';

const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_SOLO: 'price_solo', STRIPE_PRICE_FAMILY: 'price_family' };
const json = (method, body) => ({ method, body: JSON.stringify(body) });

function fakeStripe() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, params: new URLSearchParams(init.body || '') });
    const ok = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith('/checkout/sessions')) return ok({ url: 'https://checkout.stripe.com/c/pay/test' });
    if (String(url).endsWith('/billing_portal/sessions')) return ok({ url: 'https://billing.stripe.com/p/session/test' });
    if (String(url).includes('/subscriptions?customer=')) return ok({ data: [{ id: 'sub_1', status: 'active' }] });
    if (init.method === 'DELETE') return ok({ id: 'sub_1', status: 'canceled' });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetch };
}

function signed(event, secret = env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` } };
}

function person(s) {
  let cookie = '';
  const api = async (p, init = {}) => {
    const res = await fetch(s.base + p, { ...init, headers: { 'Content-Type': 'application/json', cookie, ...init.headers } });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return api;
}

test('without Stripe settings nothing is sold', async () => {
  const s = await start({ billing: billing({ env: {} }) });
  try {
    assert.deepEqual((await s.api('plan')).body.billing, { open: false, manage: false });
    const r = await s.api('billing/checkout', json('POST', { plan: 'solo' }));
    assert.equal(r.status, 503);
    assert.equal(r.body.notOpen, true);
    assert.equal((await fetch(s.base + 'billing/webhook', signed({ type: 'x' }))).status, 400, 'no secret, no webhook');
  } finally {
    s.close();
  }
});

test('Checkout, then the signed webhook makes the account Premium; cancelling ends it; deleting the account cancels', async () => {
  process.env.ALLOW_SIGNUP = 'true';
  const stripe = fakeStripe();
  const s = await start({ billing: billing({ env, fetch: stripe.fetch }) });
  try {
    const tom = person(s);
    const tomId = (await tom('auth/signup', json('POST', { name: 'Tom', email: 'tom@example.com', password: 'correct horse' }))).body.user.id;
    assert.deepEqual((await tom('plan')).body.billing, { open: true, manage: false });
    assert.equal((await tom('billing/checkout', json('POST', { plan: 'gold' }))).status, 400);

    const r = await tom('billing/checkout', json('POST', { plan: 'family' }));
    assert.equal(r.body.url, 'https://checkout.stripe.com/c/pay/test');
    const sent = stripe.calls.at(-1).params;
    assert.equal(sent.get('line_items[0][price]'), 'price_family');
    assert.equal(sent.get('metadata[user_id]'), tomId);
    assert.equal(sent.get('subscription_data[metadata][plan]'), 'family');
    assert.equal(sent.get('customer_email'), 'tom@example.com');
    assert.match(sent.get('success_url'), /\/\?upgraded=family$/);
    assert.equal((await tom('plan')).body.plan, 'free', 'nothing changes before Stripe confirms');

    // A forged or stale call is refused.
    const paid = { type: 'checkout.session.completed', data: { object: { customer: 'cus_1', client_reference_id: tomId, metadata: { user_id: tomId, plan: 'family' } } } };
    assert.equal((await fetch(s.base + 'billing/webhook', signed(paid, 'whsec_wrong'))).status, 400);
    assert.equal((await fetch(s.base + 'billing/webhook', signed(paid, env.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600))).status, 400);
    assert.equal((await tom('plan')).body.plan, 'free');

    assert.equal((await fetch(s.base + 'billing/webhook', signed(paid))).status, 200);
    const plan = (await tom('plan')).body;
    assert.equal(plan.plan, 'family');
    assert.equal(plan.premium, true);
    assert.deepEqual(plan.billing, { open: true, manage: true });
    assert.ok(s.insights.firstTime(tomId, 'subscription_started'));
    assert.equal((await tom('billing/checkout', json('POST', { plan: 'solo' }))).status, 409, 'no second subscription');

    // Manage subscription: Stripe's portal for this customer.
    assert.equal((await tom('billing/portal', json('POST', {}))).body.url, 'https://billing.stripe.com/p/session/test');
    assert.equal(stripe.calls.at(-1).params.get('customer'), 'cus_1');

    // Switching to Solo in the portal, then cancelling.
    const sub = (status, price) => ({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1', status, metadata: { user_id: tomId, plan: 'family' }, items: { data: [{ price: { id: price } }] } } } });
    await fetch(s.base + 'billing/webhook', signed(sub('active', 'price_solo')));
    assert.equal((await tom('plan')).body.plan, 'solo');
    await fetch(s.base + 'billing/webhook', signed({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1', metadata: { user_id: tomId } } } }));
    assert.equal((await tom('plan')).body.plan, 'free');
    assert.ok(s.insights.firstTime(tomId, 'subscription_ended'));

    // The owner's plan is never changed by a payment event.
    const ownerPaid = { ...paid, data: { object: { ...paid.data.object, customer: 'cus_owner', client_reference_id: s.user.id, metadata: { user_id: s.user.id, plan: 'solo' } } } };
    await fetch(s.base + 'billing/webhook', signed(ownerPaid));
    assert.equal((await s.api('plan')).body.plan, 'family');

    // Deleting the account ends the subscription at Stripe.
    assert.equal((await tom('account/delete', json('POST', { email: 'tom@example.com' }))).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(stripe.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/subscriptions/sub_1')));
  } finally {
    s.close();
    delete process.env.ALLOW_SIGNUP;
  }
});
