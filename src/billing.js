import express from "express";
import Stripe from "stripe";
import { requireUser } from "./auth.js";
import {
  applySubscription, getBillingUser, getPlanById, listPlans, saveStripeCustomer,
} from "./store.js";

/*
 * Stripe subscriptions:
 *  1. POST /api/billing/checkout { plan } -> Stripe Checkout URL (new subscribers)
 *  2. Stripe calls POST /api/stripe/webhook -> we fetch the subscription and set the user's plan
 *  3. POST /api/billing/portal -> Stripe Customer Portal URL (upgrade, downgrade, cancel, update card)
 * Prices and amounts live in Stripe; each paid row in `plans` points at a Stripe Price id.
 */

const secretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const appUrl = (process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

export const stripe = secretKey
  ? new Stripe(secretKey, {
      // Optional: point at stripe-mock (github.com/stripe/stripe-mock) for offline tests.
      ...(process.env.STRIPE_API_HOST && {
        host: process.env.STRIPE_API_HOST,
        port: process.env.STRIPE_API_PORT,
        protocol: process.env.STRIPE_API_PROTOCOL ?? "https",
      }),
    })
  : null;

const ACTIVE = new Set(["active", "trialing", "past_due"]);

function requireStripe(_req, res, next) {
  if (!stripe) return res.status(503).json({ error: "Billing is not configured (set STRIPE_SECRET_KEY)" });
  next();
}

/** Fetch a subscription from Stripe and apply its current state. Safe to repeat. */
async function syncSubscription(subscriptionId, userId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items.data[0];
  return applySubscription({
    userId: userId ?? sub.metadata?.user_id ?? null,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    subscriptionId: sub.id,
    status: sub.status,
    priceId: item?.price?.id,
    periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  });
}

async function getOrCreateCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create(
    { email: user.email, metadata: { user_id: user.id } },
    // Two concurrent checkouts for one user create a single customer.
    { idempotencyKey: `customer-${user.id}` },
  );
  return saveStripeCustomer(user.id, customer.id);
}

// Plan prices from Stripe, cached briefly for GET /api/plans.
let priceCache = { at: 0, byId: new Map() };
async function priceDetails(priceIds) {
  if (!stripe) return new Map();
  if (Date.now() - priceCache.at > 10 * 60 * 1000) {
    const byId = new Map();
    await Promise.all(
      priceIds.map(async (id) => {
        try {
          const p = await stripe.prices.retrieve(id);
          byId.set(id, { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? null });
        } catch (err) {
          console.error(`Could not load Stripe price ${id}:`, err.message);
        }
      }),
    );
    priceCache = { at: Date.now(), byId };
  }
  return priceCache.byId;
}

export const billingRouter = express.Router();

/** Stripe webhook. Needs the raw body for signature checks, so mount this router before express.json(). */
billingRouter.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !webhookSecret) return res.status(503).send("Billing is not configured");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
        if (obj.mode === "subscription" && obj.subscription) {
          await syncSubscription(obj.subscription, obj.client_reference_id);
        }
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await syncSubscription(obj.id);
        break;
      default:
        break; // not subscribed to anything else
    }
    res.json({ received: true });
  } catch (err) {
    // A non-2xx makes Stripe retry with backoff for up to 3 days.
    console.error(`[stripe ${event.type} ${event.id}]`, err);
    res.status(500).send("Webhook handler failed");
  }
});

billingRouter.get("/api/plans", async (_req, res) => {
  const plans = await listPlans();
  const prices = await priceDetails(plans.map((p) => p.stripe_price_id).filter(Boolean));
  res.json(
    plans.map(({ stripe_price_id, ...p }) => ({
      ...p,
      paid: Boolean(stripe_price_id),
      purchasable: Boolean(stripe && stripe_price_id),
      price: stripe_price_id ? prices.get(stripe_price_id) ?? null : null,
    })),
  );
});

/** POST /api/billing/checkout { plan } -> { url } of a Stripe Checkout page. */
billingRouter.post("/api/billing/checkout", express.json(), requireStripe, requireUser, async (req, res) => {
  const plan = await getPlanById(String(req.body?.plan ?? ""));
  if (!plan?.stripe_price_id) return res.status(400).json({ error: "That plan can't be purchased" });

  const user = await getBillingUser(req.user.id);
  if (ACTIVE.has(user.subscription_status)) {
    return res.status(409).json({ error: "You already have a subscription. Use the billing portal to change plans.", portal: "/api/billing/portal" });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: await getOrCreateCustomer(user),
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    client_reference_id: user.id,
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: true,
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/?checkout=cancelled`,
  });
  res.json({ url: session.url });
});

/** POST /api/billing/portal -> { url } of the Stripe Customer Portal. */
billingRouter.post("/api/billing/portal", requireStripe, requireUser, async (req, res) => {
  const user = await getBillingUser(req.user.id);
  if (!user.stripe_customer_id) return res.status(400).json({ error: "No billing account yet. Subscribe to a plan first." });
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripe_customer_id, return_url: appUrl });
  res.json({ url: session.url });
});
