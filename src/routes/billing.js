import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  cancelSubscription,
  createCheckoutSession,
  createPortalSession,
  getOrganizationBilling,
  isStripeConfigured,
  listPublicPlans,
  resumeSubscription,
} from '../services/billing.js';
import { getUsageSummary } from '../services/usage.js';

const router = Router();
router.use(authenticate);

router.get('/plans', (_req, res) => {
  try {
    res.json({ plans: listPublicPlans(), stripe_configured: isStripeConfigured() });
  } catch (err) {
    console.error('Get plans error:', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

router.get('/subscription', requireRole('super_admin'), async (req, res) => {
  try {
    if (!req.user.organization_id) {
      return res.status(400).json({ error: 'No organization associated with account' });
    }
    const billing = await getOrganizationBilling(req.user.organization_id);
    res.json({ billing });
  } catch (err) {
    console.error('Get subscription error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

router.get('/usage', async (req, res) => {
  try {
    if (!req.user.organization_id) {
      return res.status(400).json({ error: 'No organization associated with account' });
    }
    const usage = await getUsageSummary(req.user.organization_id);
    res.json({ usage });
  } catch (err) {
    console.error('Get usage error:', err);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

router.post('/checkout', requireRole('super_admin'), async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !['pro', 'agency'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be pro or agency' });
    }

    const session = await createCheckoutSession(
      req.user.organization_id,
      plan,
      req.user.email
    );
    res.json(session);
  } catch (err) {
    if (err.code === 'STRIPE_NOT_CONFIGURED' || err.code === 'STRIPE_PRICE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    if (err.code === 'INVALID_PLAN') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/portal', requireRole('super_admin'), async (req, res) => {
  try {
    const session = await createPortalSession(req.user.organization_id);
    res.json(session);
  } catch (err) {
    if (err.code === 'STRIPE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    if (err.code === 'NO_CUSTOMER') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

router.post('/cancel', requireRole('super_admin'), async (req, res) => {
  try {
    const billing = await cancelSubscription(req.user.organization_id);
    res.json({ billing, message: 'Subscription will cancel at the end of the billing period' });
  } catch (err) {
    if (err.code === 'STRIPE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    if (err.code === 'NO_SUBSCRIPTION') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

router.post('/resume', requireRole('super_admin'), async (req, res) => {
  try {
    const billing = await resumeSubscription(req.user.organization_id);
    res.json({ billing, message: 'Subscription resumed' });
  } catch (err) {
    if (err.code === 'STRIPE_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    if (err.code === 'NO_SUBSCRIPTION') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Resume subscription error:', err);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

export default router;
