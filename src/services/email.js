import { Resend } from 'resend';
import pool from '../config/db.js';
import { canAccessLead, leadListFilter } from '../utils/leadAccess.js';

function hasValidResendKey() {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return false;
  if (/your[-_]?resend|placeholder|example/i.test(key)) return false;
  if (!key.startsWith('re_')) return false;
  return true;
}

function getEmailFrom() {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) return 'AutoFollow <onboarding@resend.dev>';
  if (from.includes('<')) return from;
  return `AutoFollow <${from}>`;
}

function getResend() {
  return hasValidResendKey() ? new Resend(process.env.RESEND_API_KEY) : null;
}

/** Resend v4 returns { data, error } and does not throw on API errors */
async function deliverViaResend({ to, subject, html }) {
  const client = getResend();
  if (!client) {
    return { ok: false, demo: true, message: 'No valid Resend API key configured' };
  }

  const { data, error } = await client.emails.send({
    from: getEmailFrom(),
    to,
    subject,
    html,
  });

  if (error) {
    const message = error.message || 'Resend rejected the email';
    console.error('Resend delivery error:', message);
    return { ok: false, demo: false, message };
  }

  if (!data?.id) {
    return { ok: false, demo: false, message: 'Resend did not confirm delivery' };
  }

  return { ok: true, demo: false, message: `Email sent to ${to}`, id: data.id };
}

/** Store datetimes in UTC so MySQL comparisons stay correct across timezones */
function toMysqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function scheduleEmail(user, { leadId, subject, body, scheduledAt }) {
  const lead = await canAccessLead(pool, user, leadId);

  if (!lead) {
    throw new Error('Lead not found');
  }

  const [result] = await pool.query(
    `INSERT INTO email_schedules (user_id, lead_id, subject, body, scheduled_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, leadId, subject, body, toMysqlUtc(scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt))]
  );

  const [rows] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function sendEmailNow(user, { leadId, subject, body }) {
  const lead = await canAccessLead(pool, user, leadId);

  if (!lead) {
    throw new Error('Lead not found');
  }

  const [result] = await pool.query(
    `INSERT INTO email_schedules (user_id, lead_id, subject, body, scheduled_at, status)
     VALUES (?, ?, ?, ?, NOW(), 'pending')`,
    [user.id, leadId, subject, body]
  );

  return processScheduledEmail(result.insertId);
}

async function processScheduledEmail(scheduleId) {
  const [rows] = await pool.query('SELECT es.*, l.email as lead_email, l.name as lead_name FROM email_schedules es JOIN leads l ON es.lead_id = l.id WHERE es.id = ?', [scheduleId]);

  if (rows.length === 0) return null;

  const schedule = rows[0];

  if (!getResend()) {
    await pool.query(
      `UPDATE email_schedules SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [scheduleId]
    );
    return {
      ...schedule,
      status: 'sent',
      demo: true,
      recipient: schedule.lead_email,
      message: `Demo mode — no email delivered. Would send to ${schedule.lead_email}`,
    };
  }

  try {
    const delivery = await deliverViaResend({
      to: schedule.lead_email,
      subject: schedule.subject,
      html: `<div style="font-family: sans-serif; line-height: 1.6;">${schedule.body.replace(/\n/g, '<br>')}</div>`,
    });

    if (!delivery.ok) {
      await pool.query(
        `UPDATE email_schedules SET status = 'failed', error_message = ? WHERE id = ?`,
        [delivery.message, scheduleId]
      );
      throw new Error(delivery.message);
    }

    await pool.query(
      `UPDATE email_schedules SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [scheduleId]
    );

    const [updated] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [scheduleId]);
    return {
      ...updated[0],
      demo: false,
      recipient: schedule.lead_email,
      message: delivery.message,
    };
  } catch (err) {
    await pool.query(
      `UPDATE email_schedules SET status = 'failed', error_message = ? WHERE id = ?`,
      [err.message, scheduleId]
    );
    throw err;
  }
}

export async function processPendingEmails() {
  const [pending] = await pool.query(
    `SELECT id, scheduled_at FROM email_schedules WHERE status = 'pending'`
  );

  const now = Date.now();

  for (const row of pending) {
    if (new Date(row.scheduled_at).getTime() > now) continue;

    try {
      await processScheduledEmail(row.id);
    } catch (err) {
      console.error(`Failed to send email ${row.id}:`, err.message);
    }
  }
}

export async function getEmailSchedules(user, leadId) {
  const filter = leadListFilter(user, 'l');

  const query = leadId
    ? `SELECT es.*, l.name as lead_name, l.email as lead_email
       FROM email_schedules es
       JOIN leads l ON es.lead_id = l.id
       WHERE ${filter.where} AND es.lead_id = ?
       ORDER BY es.scheduled_at DESC`
    : `SELECT es.*, l.name as lead_name, l.email as lead_email
       FROM email_schedules es
       JOIN leads l ON es.lead_id = l.id
       WHERE ${filter.where}
       ORDER BY es.scheduled_at DESC`;

  const params = leadId ? [...filter.params, leadId] : filter.params;
  const [schedules] = await pool.query(query, params);
  return schedules;
}

export async function cancelEmail(user, scheduleId) {
  const filter = leadListFilter(user, 'l');

  const [result] = await pool.query(
    `UPDATE email_schedules es
     JOIN leads l ON es.lead_id = l.id
     SET es.status = 'cancelled'
     WHERE es.id = ? AND ${filter.where} AND es.status = 'pending'`,
    [scheduleId, ...filter.params]
  );

  if (result.affectedRows === 0) {
    throw new Error('Email schedule not found or already processed');
  }

  const [rows] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [scheduleId]);
  return rows[0];
}

export async function sendInviteEmail({
  to,
  inviteLink,
  organizationName,
  roleLabel,
  inviterName,
}) {
  const subject = `You're invited to join ${organizationName} on AutoFollow`;

  const html = `
    <div style="font-family: sans-serif; line-height: 1.6; max-width: 560px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #4f46e5; margin-bottom: 8px;">You're invited!</h2>
      <p>Hi,</p>
      <p>
        <strong>${inviterName}</strong> has invited you to join
        <strong>${organizationName}</strong> on AutoFollow AI CRM as <strong>${roleLabel}</strong>.
      </p>
      <p>Click the button below to create your account and join the team:</p>
      <p style="margin: 28px 0;">
        <a href="${inviteLink}"
           style="background: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
          Accept invitation
        </a>
      </p>
      <p style="font-size: 14px; color: #64748b;">
        Or copy this link into your browser:<br>
        <a href="${inviteLink}" style="color: #4f46e5; word-break: break-all;">${inviteLink}</a>
      </p>
      <p style="font-size: 14px; color: #64748b;">This invitation expires in 7 days.</p>
      <p style="font-size: 14px; color: #94a3b8; margin-top: 32px;">— AutoFollow AI CRM</p>
    </div>
  `;

  if (!getResend()) {
    return {
      sent: false,
      demo: true,
      message: `Demo mode — email not sent. Copy the invite link and share it with ${to}.`,
    };
  }

  const delivery = await deliverViaResend({ to, subject, html });

  if (!delivery.ok) {
    const sandboxHint = delivery.message.includes('testing emails to your own email')
      ? ' With onboarding@resend.dev you can only email your Resend account address until you verify a domain.'
      : '';
    return {
      sent: false,
      demo: false,
      message: `${delivery.message}${sandboxHint} Copy the invite link below.`,
    };
  }

  return {
    sent: true,
    demo: false,
    message: delivery.message,
  };
}
