import { Router } from 'express';
import Stripe from 'stripe';
import {
  handleCheckoutCompleted,
  handleSubscriptionDeleted,
  syncSubscriptionToOrg,
} from '../services/billing.js';

const router = Router();

router.post('/', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!secret || !stripeKey) {
    return res.status(503).json({ error: 'Stripe webhooks not configured' });
  }

  const stripe = new Stripe(stripeKey);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await syncSubscriptionToOrg(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        if (event.data.object.subscription) {
          const subscription = await stripe.subscriptions.retrieve(event.data.object.subscription);
          await syncSubscriptionToOrg(subscription);
        }
        break;
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
