// Paying for Solo or Family, through Stripe (stripe.com). Turned on by four
// settings: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_SOLO and
// STRIPE_PRICE_FAMILY (the monthly prices made in Stripe's dashboard).
// Without them nothing is sold: "Get Premium" stays a "tell me when" button.
//
// The person pays on Stripe's own page (Checkout), so card numbers never
// reach this server. Stripe then calls /api/billing/webhook, signed with the
// webhook secret, and the account's plan changes. "Manage subscription"
// opens Stripe's customer portal (change plan, card, invoices, cancel).
import crypto from 'node:crypto';

export const PLANS = ['solo', 'family'];
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function billing({ env = process.env, fetch = globalThis.fetch } = {}) {
  const key = env.STRIPE_SECRET_KEY;
  const secret = env.STRIPE_WEBHOOK_SECRET;
  const prices = { solo: env.STRIPE_PRICE_SOLO, family: env.STRIPE_PRICE_FAMILY };
  const configured = !!(key && secret && prices.solo && prices.family);

  async function stripe(path, params, method = 'POST') {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Stripe answered ${res.status}`);
    return body;
  }

  return {
    configured,

    /** The plan a Stripe price stands for. */
    planOfPrice: (priceId) => PLANS.find((p) => prices[p] === priceId) || null,

    /** A Stripe Checkout page for this plan; returns its address. */
    async checkout({ user, plan, customer, base }) {
      const params = {
        mode: 'subscription',
        'line_items[0][price]': prices[plan],
        'line_items[0][quantity]': '1',
        client_reference_id: user.id,
        success_url: `${base}/?upgraded=${plan}`,
        cancel_url: `${base}/?upgraded=cancelled`,
        allow_promotion_codes: 'true',
        'metadata[user_id]': user.id,
        'metadata[plan]': plan,
        'subscription_data[metadata][user_id]': user.id,
        'subscription_data[metadata][plan]': plan,
      };
      if (customer) params.customer = customer;
      else if (user.email && !user.email.endsWith('.invalid')) params.customer_email = user.email;
      return (await stripe('checkout/sessions', params)).url;
    },

    /** Stripe's page to change plan or card, see invoices, or cancel. */
    async portal({ customer, base }) {
      return (await stripe('billing_portal/sessions', { customer, return_url: `${base}/` })).url;
    },

    /** Ends every subscription of this customer at once (the account was deleted). */
    async cancelAll(customer) {
      const subs = await stripe(`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`, null, 'GET');
      for (const sub of subs.data || []) {
        if (sub.status !== 'canceled') await stripe(`subscriptions/${sub.id}`, null, 'DELETE');
      }
    },

    /**
     * Checks that a webhook call really comes from Stripe (Stripe-Signature:
     * t=<time>,v1=<HMAC-SHA256 of "time.body">, at most 5 minutes old) and
     * returns the event, or null.
     */
    verify(raw, header, now = Date.now()) {
      if (!secret || !header) return null;
      const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2)
        .map(([k, v]) => [k.trim(), v.trim()]));
      const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
      const t = Number(parts.t);
      if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
      const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
      const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
      if (!ok) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    /**
     * What a Stripe event means for an account: {userId, plan, customer}
     * (plan 'free' when a subscription ends), or null when it changes nothing.
     */
    effect(event) {
      const o = event?.data?.object || {};
      const userId = o.metadata?.user_id || o.client_reference_id;
      if (!userId) return null;
      if (event.type === 'checkout.session.completed') {
        const plan = PLANS.includes(o.metadata?.plan) ? o.metadata.plan : null;
        return plan ? { userId, plan, customer: o.customer || null } : null;
      }
      if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
        if (!ACTIVE.has(o.status)) return { userId, plan: 'free', customer: o.customer || null };
        const plan = this.planOfPrice(o.items?.data?.[0]?.price?.id) || (PLANS.includes(o.metadata?.plan) ? o.metadata.plan : null);
        return plan ? { userId, plan, customer: o.customer || null } : null;
      }
      if (event.type === 'customer.subscription.deleted') return { userId, plan: 'free', customer: o.customer || null };
      return null;
    },
  };
}
