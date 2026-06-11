export const PLAN_IDS = ['free', 'pro', 'agency'];

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'Get started with core CRM features',
    priceMonthly: 0,
    limits: {
      ai_requests: 50,
      leads: 25,
      emails: 50,
      team_members: 1,
      storage_mb: 100,
    },
    features: [
      'Up to 25 leads',
      '50 AI messages / month',
      '50 emails / month',
      '1 team member',
      'Email reply sync',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For growing sales teams',
    priceMonthly: 49,
    limits: {
      ai_requests: 500,
      leads: 500,
      emails: 1000,
      team_members: 5,
      storage_mb: 1024,
    },
    features: [
      'Up to 500 leads',
      '500 AI messages / month',
      '1,000 emails / month',
      '5 team members',
      'Follow-up sequences',
      'Activity timeline',
    ],
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    description: 'For agencies managing multiple clients',
    priceMonthly: 149,
    limits: {
      ai_requests: 5000,
      leads: 5000,
      emails: 10000,
      team_members: 20,
      storage_mb: 10240,
    },
    features: [
      'Up to 5,000 leads',
      '5,000 AI messages / month',
      '10,000 emails / month',
      '20 team members',
      'Priority support',
      'All Pro features',
    ],
  },
};

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

export function getPlanLimits(planId) {
  return getPlan(planId).limits;
}

export function planFromStripePriceId(priceId) {
  if (!priceId) return 'free';
  const proPrice = process.env.STRIPE_PRICE_PRO?.trim();
  const agencyPrice = process.env.STRIPE_PRICE_AGENCY?.trim();
  if (priceId === agencyPrice) return 'agency';
  if (priceId === proPrice) return 'pro';
  return null;
}
