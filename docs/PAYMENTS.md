# Turning on payments (Stripe)

record.ai sells Solo (€3.99/month) and Family (€5.99/month) through
[Stripe](https://stripe.com). People pay on Stripe's own page, so card
numbers never reach the server. Until the four settings below are set,
nothing is sold: "Get Premium" only counts who would buy (`upgrade_click`).

## Steps (about 30 minutes, in Stripe's dashboard)

1. **Create a Stripe account** at stripe.com with your business details
   (needs your business set up first: see the launch checklist).
   Start in **Test mode** (the switch at the top) to try it without real money.
2. **Products → Add product**, twice:
   - "record.ai Solo", recurring, monthly, €3.99
   - "record.ai Family", recurring, monthly, €5.99

   Copy each **price id** (it starts with `price_`).
3. **Developers → API keys**: copy the **Secret key** (`sk_test_…`, later `sk_live_…`).
   Never paste it in a chat or a screenshot.
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://record-ai-nina.fly.dev/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`

   Copy the **Signing secret** (`whsec_…`).
5. **Settings → Billing → Customer portal**: turn it on, and allow
   cancelling, switching between the two prices, and updating the card.
6. Put the four values on the server, from your computer's Terminal:

   ```
   fly secrets set STRIPE_SECRET_KEY=sk_… STRIPE_WEBHOOK_SECRET=whsec_… \
     STRIPE_PRICE_SOLO=price_… STRIPE_PRICE_FAMILY=price_… \
     PUBLIC_URL=https://record-ai-nina.fly.dev
   ```

   The app restarts and "Get Premium" now shows the two plans.
7. **Try it** in Test mode with the card `4242 4242 4242 4242`, any future
   date, any code. Your plan should show "Family" a few seconds after paying.
   Then switch Stripe to Live mode, and repeat steps 2–4 and 6 with the live values.

## What happens

| When | What the app does |
|---|---|
| "Get Premium" → a plan | `POST /api/billing/checkout` opens Stripe's payment page |
| Paid | Stripe calls the webhook (signed); the account becomes Solo or Family; event `subscription_started` |
| Plan changed or cancelled in "Manage subscription" | The webhook updates the plan; cancelled = back to Free (`subscription_ended`) |
| Account deleted | Its Stripe subscriptions are cancelled, so it is never charged again |

The owner's account always has everything and is never changed by payments.

## Not done yet (on purpose)

- **iPhone and Android:** Apple and Google require their own in-app payments
  for digital subscriptions bought inside the apps. Until those are added, the
  apps show Premium but people subscribe on the web. Check the current App
  Store rules before launch: in some countries a link to the web is allowed.
- **VAT:** turn on Stripe Tax, or ask your commercialista how VAT on digital
  services in the EU should be handled (OSS).
