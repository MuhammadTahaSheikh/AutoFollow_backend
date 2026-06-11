import Stripe from 'stripe';
import pool from '../config/db.js';
import { getPrimaryFrontendUrl } from '../utils/frontendUrl.js';
import { PLAN_IDS, PLANS, getPlan, planFromStripePriceId } from '../config/plans.js';

let stripeClient = null;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    const err = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env');
    err.code = 'STRIPE_NOT_CONFIGURED';
    throw err;
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

export async function getOrganizationBilling(organizationId) {
  const [rows] = await pool.query(
    `SELECT id, name, plan, stripe_customer_id, stripe_subscription_id,
            subscription_status, current_period_end, cancel_at_period_end
     FROM organizations WHERE id = ?`,
    [organizationId]
  );

  if (rows.length === 0) {
    const err = new Error('Organization not found');
    err.code = 'ORG_NOT_FOUND';
    throw err;
  }

  const org = rows[0];
  const plan = getPlan(org.plan);

  return {
    organization_id: org.id,
    organization_name: org.name,
    plan: org.plan || 'free',
    plan_name: plan.name,
    price_monthly: plan.priceMonthly,
    limits: plan.limits,
    features: plan.features,
    stripe_configured: isStripeConfigured(),
    subscription: {
      status: org.subscription_status || 'active',
      current_period_end: org.current_period_end,
      cancel_at_period_end: Boolean(org.cancel_at_period_end),
      has_stripe_subscription: Boolean(org.stripe_subscription_id),
    },
  };
}

async function getOrCreateStripeCustomer(organizationId, email, name) {
  const [rows] = await pool.query(
    'SELECT stripe_customer_id, name FROM organizations WHERE id = ?',
    [organizationId]
  );

  if (rows.length === 0) {
    throw new Error('Organization not found');
  }

  const org = rows[0];
  if (org.stripe_customer_id) {
    return org.stripe_customer_id;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name: org.name,
    metadata: { organization_id: String(organizationId) },
  });

  await pool.query(
    'UPDATE organizations SET stripe_customer_id = ? WHERE id = ?',
    [customer.id, organizationId]
  );

  return customer.id;
}

function getPriceIdForPlan(planId) {
  const envKey = planId === 'agency' ? 'STRIPE_PRICE_AGENCY' : 'STRIPE_PRICE_PRO';
  const priceId = process.env[envKey]?.trim();
  if (!priceId) {
    const err = new Error(`Stripe price not configured. Set ${envKey} in backend/.env`);
    err.code = 'STRIPE_PRICE_NOT_CONFIGURED';
    throw err;
  }
  return priceId;
}

export async function createCheckoutSession(organizationId, planId, userEmail) {
  if (planId === 'free') {
    const err = new Error('Use the billing portal to manage or cancel your subscription');
    err.code = 'INVALID_PLAN';
    throw err;
  }

  if (!PLANS[planId]) {
    const err = new Error('Invalid plan');
    err.code = 'INVALID_PLAN';
    throw err;
  }

  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(organizationId, userEmail);
  const frontendUrl = getPrimaryFrontendUrl();
  const priceId = getPriceIdForPlan(planId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}/dashboard/billing?checkout=success`,
    cancel_url: `${frontendUrl}/dashboard/billing?checkout=cancelled`,
    metadata: {
      organization_id: String(organizationId),
      plan: planId,
    },
    subscription_data: {
      metadata: {
        organization_id: String(organizationId),
        plan: planId,
      },
    },
    allow_promotion_codes: true,
  });

  return { url: session.url, session_id: session.id };
}

export async function createPortalSession(organizationId) {
  const [rows] = await pool.query(
    'SELECT stripe_customer_id FROM organizations WHERE id = ?',
    [organizationId]
  );

  if (rows.length === 0 || !rows[0].stripe_customer_id) {
    const err = new Error('No billing account found. Upgrade to a paid plan first.');
    err.code = 'NO_CUSTOMER';
    throw err;
  }

  const stripe = getStripe();
  const frontendUrl = getPrimaryFrontendUrl();

  const session = await stripe.billingPortal.sessions.create({
    customer: rows[0].stripe_customer_id,
    return_url: `${frontendUrl}/dashboard/billing`,
  });

  return { url: session.url };
}

export async function cancelSubscription(organizationId) {
  const [rows] = await pool.query(
    'SELECT stripe_subscription_id FROM organizations WHERE id = ?',
    [organizationId]
  );

  if (rows.length === 0 || !rows[0].stripe_subscription_id) {
    const err = new Error('No active subscription to cancel');
    err.code = 'NO_SUBSCRIPTION';
    throw err;
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.update(rows[0].stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  await syncSubscriptionToOrg(subscription);
  return getOrganizationBilling(organizationId);
}

export async function resumeSubscription(organizationId) {
  const [rows] = await pool.query(
    'SELECT stripe_subscription_id FROM organizations WHERE id = ?',
    [organizationId]
  );

  if (rows.length === 0 || !rows[0].stripe_subscription_id) {
    const err = new Error('No subscription to resume');
    err.code = 'NO_SUBSCRIPTION';
    throw err;
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.update(rows[0].stripe_subscription_id, {
    cancel_at_period_end: false,
  });

  await syncSubscriptionToOrg(subscription);
  return getOrganizationBilling(organizationId);
}

export async function syncSubscriptionToOrg(subscription) {
  const organizationId = subscription.metadata?.organization_id;
  if (!organizationId) return;

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planFromStripePriceId(priceId) || subscription.metadata?.plan || 'free';
  const isActive = ['active', 'trialing', 'past_due'].includes(subscription.status);

  await pool.query(
    `UPDATE organizations SET
       plan = ?,
       stripe_subscription_id = ?,
       subscription_status = ?,
       current_period_end = FROM_UNIXTIME(?),
       cancel_at_period_end = ?
     WHERE id = ?`,
    [
      isActive ? plan : 'free',
      subscription.id,
      subscription.status,
      subscription.current_period_end,
      subscription.cancel_at_period_end ? 1 : 0,
      organizationId,
    ]
  );
}

export async function handleCheckoutCompleted(session) {
  const organizationId = session.metadata?.organization_id;
  if (!organizationId) return;

  const subscriptionId = session.subscription;
  if (!subscriptionId) return;

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await syncSubscriptionToOrg(subscription);
}

export async function handleSubscriptionDeleted(subscription) {
  const organizationId = subscription.metadata?.organization_id;
  if (!organizationId) return;

  await pool.query(
    `UPDATE organizations SET
       plan = 'free',
       stripe_subscription_id = NULL,
       subscription_status = 'canceled',
       current_period_end = NULL,
       cancel_at_period_end = 0
     WHERE id = ?`,
    [organizationId]
  );
}

export function listPublicPlans() {
  return PLAN_IDS.map((id) => {
    const plan = PLANS[id];
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      price_monthly: plan.priceMonthly,
      limits: plan.limits,
      features: plan.features,
      stripe_price_configured:
        id === 'free' ||
        (id === 'pro' && Boolean(process.env.STRIPE_PRICE_PRO?.trim())) ||
        (id === 'agency' && Boolean(process.env.STRIPE_PRICE_AGENCY?.trim())),
    };
  });
}
