import pool from '../config/db.js';
import { getPlanLimits } from '../config/plans.js';

function currentPeriodStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

async function getOrgPlan(organizationId) {
  const [rows] = await pool.query('SELECT plan FROM organizations WHERE id = ?', [organizationId]);
  return rows[0]?.plan || 'free';
}

async function ensureUsageRow(connection, organizationId, periodStart) {
  await connection.query(
    `INSERT IGNORE INTO usage_counters (organization_id, period_start)
     VALUES (?, ?)`,
    [organizationId, periodStart]
  );
}

export async function incrementUsage(organizationId, metric, amount = 1) {
  const periodStart = currentPeriodStart();
  const connection = await pool.getConnection();
  try {
    await ensureUsageRow(connection, organizationId, periodStart);
    const column = {
      ai_requests: 'ai_requests',
      emails: 'emails_sent',
      storage_bytes: 'storage_bytes',
    }[metric];

    if (!column) return;

    await connection.query(
      `UPDATE usage_counters SET ${column} = ${column} + ? WHERE organization_id = ? AND period_start = ?`,
      [amount, organizationId, periodStart]
    );
  } finally {
    connection.release();
  }
}

async function countTeamMembers(organizationId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS count FROM users WHERE organization_id = ?',
    [organizationId]
  );
  return rows[0].count;
}

async function countLeads(organizationId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS count FROM leads WHERE organization_id = ?',
    [organizationId]
  );
  return rows[0].count;
}

async function getMonthlyCounters(organizationId) {
  const periodStart = currentPeriodStart();
  const [rows] = await pool.query(
    `SELECT ai_requests, emails_sent, storage_bytes
     FROM usage_counters
     WHERE organization_id = ? AND period_start = ?`,
    [organizationId, periodStart]
  );

  return rows[0] || { ai_requests: 0, emails_sent: 0, storage_bytes: 0 };
}

async function countPendingEmails(organizationId) {
  const periodStart = currentPeriodStart();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM email_schedules es
     INNER JOIN leads l ON l.id = es.lead_id
     WHERE l.organization_id = ? AND es.status = 'pending' AND es.created_at >= ?`,
    [organizationId, periodStart]
  );
  return rows[0].count;
}

async function countPendingInvitations(organizationId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM invitations
     WHERE organization_id = ? AND status = 'pending' AND expires_at > NOW()`,
    [organizationId]
  );
  return rows[0].count;
}

export async function getUsageSummary(organizationId) {
  const planId = await getOrgPlan(organizationId);
  const limits = getPlanLimits(planId);
  const counters = await getMonthlyCounters(organizationId);
  const pendingEmails = await countPendingEmails(organizationId);
  const teamMembers = await countTeamMembers(organizationId);
  const pendingInvites = await countPendingInvitations(organizationId);
  const leads = await countLeads(organizationId);
  const storageMb = Math.round((counters.storage_bytes || 0) / (1024 * 1024) * 10) / 10;
  const emailsUsed = counters.emails_sent + pendingEmails;

  return {
    plan: planId,
    period_start: currentPeriodStart(),
    usage: {
      ai_requests: { used: counters.ai_requests, limit: limits.ai_requests },
      emails: { used: emailsUsed, limit: limits.emails },
      leads: { used: leads, limit: limits.leads },
      team_members: { used: teamMembers + pendingInvites, limit: limits.team_members },
      storage_mb: { used: storageMb, limit: limits.storage_mb },
    },
  };
}

function buildLimitError(metric, used, limit, planId) {
  const labels = {
    ai_requests: 'AI requests',
    emails: 'emails',
    leads: 'leads',
    team_members: 'team members',
    storage_mb: 'storage',
  };
  const err = new Error(
    `${labels[metric] || metric} limit reached (${used}/${limit}). Upgrade your ${planId} plan to continue.`
  );
  err.code = 'USAGE_LIMIT_EXCEEDED';
  err.metric = metric;
  err.used = used;
  err.limit = limit;
  err.plan = planId;
  return err;
}

export async function assertWithinLimit(organizationId, metric) {
  const planId = await getOrgPlan(organizationId);
  const limits = getPlanLimits(planId);
  const counters = await getMonthlyCounters(organizationId);

  switch (metric) {
    case 'ai_requests': {
      const used = counters.ai_requests;
      if (used >= limits.ai_requests) {
        throw buildLimitError('ai_requests', used, limits.ai_requests, planId);
      }
      break;
    }
    case 'emails': {
      const pending = await countPendingEmails(organizationId);
      const used = counters.emails_sent + pending;
      if (used >= limits.emails) {
        throw buildLimitError('emails', used, limits.emails, planId);
      }
      break;
    }
    case 'leads': {
      const used = await countLeads(organizationId);
      if (used >= limits.leads) {
        throw buildLimitError('leads', used, limits.leads, planId);
      }
      break;
    }
    case 'team_members': {
      const members = await countTeamMembers(organizationId);
      const pending = await countPendingInvitations(organizationId);
      const used = members + pending;
      if (used >= limits.team_members) {
        throw buildLimitError('team_members', used, limits.team_members, planId);
      }
      break;
    }
    default:
      break;
  }
}

export async function handleUsageLimitError(err, res) {
  if (err.code === 'USAGE_LIMIT_EXCEEDED') {
    res.status(403).json({
      error: err.message,
      code: err.code,
      metric: err.metric,
      used: err.used,
      limit: err.limit,
      plan: err.plan,
    });
    return true;
  }
  return false;
}
