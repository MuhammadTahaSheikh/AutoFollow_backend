import pool from '../config/db.js';
import { canAccessLead, leadListFilter } from '../utils/leadAccess.js';
import { logActivity } from './activity.js';
import { ACTIVITY_TYPES } from '../utils/activityTypes.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function toMysqlUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function findLeadByReplyEmail(fromEmail, organizationId) {
  const email = normalizeEmail(fromEmail);
  if (!email) return null;

  const orgId =
    organizationId ||
    (process.env.N8N_WEBHOOK_ORGANIZATION_ID
      ? parseInt(process.env.N8N_WEBHOOK_ORGANIZATION_ID, 10)
      : null);

  if (orgId) {
    const [rows] = await pool.query(
      `SELECT * FROM leads WHERE organization_id = ? AND LOWER(email) = ?
       ORDER BY updated_at DESC LIMIT 1`,
      [orgId, email]
    );
    return rows[0] || null;
  }

  const [rows] = await pool.query(
    `SELECT * FROM leads WHERE LOWER(email) = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export async function recordInboundReply(payload) {
  const {
    from_email,
    from_name,
    subject,
    body_text,
    body_html,
    received_at,
    message_id,
    in_reply_to,
    source = 'n8n',
    organization_id,
  } = payload;

  const fromEmail = normalizeEmail(from_email);
  if (!fromEmail) {
    throw new Error('from_email is required');
  }

  if (message_id) {
    const [existing] = await pool.query(
      'SELECT id, lead_id FROM email_replies WHERE message_id = ?',
      [message_id]
    );
    if (existing.length > 0) {
      return { reply: existing[0], duplicate: true };
    }
  }

  const lead = await findLeadByReplyEmail(fromEmail, organization_id);
  if (!lead) {
    const err = new Error(`No lead found for ${fromEmail}`);
    err.code = 'LEAD_NOT_FOUND';
    throw err;
  }

  const bodyText = body_text?.trim() || body_html?.replace(/<[^>]+>/g, ' ').trim() || '(No content)';
  const receivedAt = received_at ? toMysqlUtc(received_at) : toMysqlUtc(new Date());

  const [result] = await pool.query(
    `INSERT INTO email_replies
      (organization_id, lead_id, from_email, from_name, subject, body_text, body_html, message_id, in_reply_to, received_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lead.organization_id,
      lead.id,
      fromEmail,
      from_name?.trim() || null,
      subject?.trim() || '(No subject)',
      bodyText,
      body_html || null,
      message_id || null,
      in_reply_to || null,
      receivedAt,
      source,
    ]
  );

  const [rows] = await pool.query('SELECT * FROM email_replies WHERE id = ?', [result.insertId]);
  const reply = rows[0];

  await logActivity(pool, {
    organizationId: lead.organization_id,
    leadId: lead.id,
    userId: lead.user_id,
    activityType: ACTIVITY_TYPES.EMAIL_RECEIVED,
    description: `Reply received from ${from_name || fromEmail}: "${subject?.trim() || 'No subject'}"`,
    metadata: {
      replyId: reply.id,
      from_email: fromEmail,
      message_id: message_id || null,
    },
  });

  if (lead.status === 'new') {
    await pool.query(
      `UPDATE leads SET status = 'contacted' WHERE id = ? AND status = 'new'`,
      [lead.id]
    );
    await logActivity(pool, {
      organizationId: lead.organization_id,
      leadId: lead.id,
      userId: lead.user_id,
      activityType: ACTIVITY_TYPES.LEAD_STATUS_CHANGED,
      description: 'Status changed from new to contacted (lead replied)',
      metadata: { from: 'new', to: 'contacted', reason: 'email_reply' },
    });
  }

  return { reply, duplicate: false, lead };
}

export async function getEmailReplies(user, leadId) {
  const lead = await canAccessLead(pool, user, leadId);
  if (!lead) throw new Error('Lead not found');

  const [replies] = await pool.query(
    `SELECT * FROM email_replies WHERE lead_id = ? ORDER BY received_at DESC`,
    [leadId]
  );

  return replies;
}

export async function getAllEmailReplies(user) {
  const filter = leadListFilter(user, 'l');

  const [replies] = await pool.query(
    `SELECT er.*, l.name as lead_name, l.email as lead_email
     FROM email_replies er
     JOIN leads l ON l.id = er.lead_id
     WHERE ${filter.where}
     ORDER BY er.received_at DESC`,
    filter.params
  );

  return replies;
}
