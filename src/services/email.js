import { Resend } from 'resend';
import pool from '../config/db.js';
import { canAccessLead, leadListFilter } from '../utils/leadAccess.js';
import { logActivity } from './activity.js';
import { ACTIVITY_TYPES } from '../utils/activityTypes.js';
import { incrementUsage } from './usage.js';

function hasValidResendKey() {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return false;
  if (/your[-_]?resend|placeholder|example/i.test(key)) return false;
  if (!key.startsWith('re_')) return false;
  return true;
}

function getEmailFrom() {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from) return 'bestechVison <onboarding@resend.dev>';
  if (from.includes('<')) return from;
  return `bestechVison <${from}>`;
}

function isSandboxSender() {
  return getEmailFrom().includes('onboarding@resend.dev');
}

function getResend() {
  return hasValidResendKey() ? new Resend(process.env.RESEND_API_KEY) : null;
}

/** Resend v4 returns { data, error } and does not throw on API errors */
async function deliverViaResend({ to, subject, html, text, replyTo }) {
  const client = getResend();
  if (!client) {
    return { ok: false, demo: true, message: 'No valid Resend API key configured' };
  }

  const payload = {
    from: getEmailFrom(),
    to,
    subject,
    html,
  };

  if (text) payload.text = text;
  if (replyTo) payload.replyTo = replyTo;

  const { data, error } = await client.emails.send(payload);

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
  const schedule = rows[0];

  const [leadRows] = await pool.query(
    'SELECT organization_id, name FROM leads WHERE id = ?',
    [leadId]
  );

  if (leadRows[0]) {
    await logActivity(pool, {
      organizationId: leadRows[0].organization_id,
      leadId,
      userId: user.id,
      activityType: ACTIVITY_TYPES.EMAIL_SCHEDULED,
      description: `Email scheduled: "${subject}"`,
      metadata: { emailScheduleId: schedule.id, scheduledAt: schedule.scheduled_at },
    });
  }

  return schedule;
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

async function syncLeadFollowUpStatus(leadId, scheduledAt, status, sentAt = null) {
  await pool.query(
    `UPDATE lead_follow_ups SET status = ?, sent_at = COALESCE(?, sent_at)
     WHERE lead_id = ? AND scheduled_at = ? AND status IN ('pending', 'sent', 'failed')`,
    [status, sentAt, leadId, scheduledAt]
  );
}

async function logEmailActivity(schedule, activityType, description, extraMetadata = {}) {
  const [leadRows] = await pool.query(
    'SELECT organization_id FROM leads WHERE id = ?',
    [schedule.lead_id]
  );
  if (!leadRows[0]) return;

  await logActivity(pool, {
    organizationId: leadRows[0].organization_id,
    leadId: schedule.lead_id,
    userId: schedule.user_id,
    activityType,
    description,
    metadata: { emailScheduleId: schedule.id, subject: schedule.subject, ...extraMetadata },
  });
}

async function processScheduledEmail(scheduleId) {
  const [rows] = await pool.query(
    `SELECT es.*, l.email as lead_email, l.name as lead_name, l.organization_id
     FROM email_schedules es
     JOIN leads l ON es.lead_id = l.id
     WHERE es.id = ?`,
    [scheduleId]
  );

  if (rows.length === 0) return null;

  const schedule = rows[0];

  if (!getResend()) {
    await pool.query(
      `UPDATE email_schedules SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [scheduleId]
    );
    await syncLeadFollowUpStatus(schedule.lead_id, schedule.scheduled_at, 'sent', toMysqlUtc(new Date()));
    await logEmailActivity(
      schedule,
      ACTIVITY_TYPES.EMAIL_SENT,
      `Email sent: "${schedule.subject}" (demo mode)`
    );
    if (schedule.organization_id) {
      await incrementUsage(schedule.organization_id, 'emails');
    }
    return {
      ...schedule,
      status: 'sent',
      demo: true,
      recipient: schedule.lead_email,
      message: `Demo mode — no email delivered. Would send to ${schedule.lead_email}`,
    };
  }

  try {
    const text = schedule.body;
    const html = `<div style="font-family: sans-serif; line-height: 1.6;">${schedule.body.replace(/\n/g, '<br>')}</div>`;
    const replyTo = process.env.INVITE_REPLY_TO?.trim() || process.env.SUPPORT_EMAIL?.trim();

    const delivery = await deliverViaResend({
      to: schedule.lead_email,
      subject: schedule.subject,
      html,
      text,
      replyTo,
    });

    if (!delivery.ok) {
      await pool.query(
        `UPDATE email_schedules SET status = 'failed', error_message = ? WHERE id = ?`,
        [delivery.message, scheduleId]
      );
      await syncLeadFollowUpStatus(schedule.lead_id, schedule.scheduled_at, 'failed');
      await logEmailActivity(
        schedule,
        ACTIVITY_TYPES.EMAIL_FAILED,
        `Email failed: "${schedule.subject}"`,
        { error: delivery.message }
      );
      throw new Error(delivery.message);
    }

    console.log(`Lead email sent to ${schedule.lead_email} (id: ${delivery.id}) subject: ${schedule.subject}`);

    await pool.query(
      `UPDATE email_schedules SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [scheduleId]
    );
    await syncLeadFollowUpStatus(schedule.lead_id, schedule.scheduled_at, 'sent', toMysqlUtc(new Date()));
    await logEmailActivity(
      schedule,
      ACTIVITY_TYPES.EMAIL_SENT,
      `Email sent: "${schedule.subject}"`
    );
    if (schedule.organization_id) {
      await incrementUsage(schedule.organization_id, 'emails');
    }

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
    await syncLeadFollowUpStatus(schedule.lead_id, schedule.scheduled_at, 'failed');
    await logEmailActivity(
      schedule,
      ACTIVITY_TYPES.EMAIL_FAILED,
      `Email failed: "${schedule.subject}"`,
      { error: err.message }
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
  const schedule = rows[0];

  await syncLeadFollowUpStatus(schedule.lead_id, schedule.scheduled_at, 'cancelled');
  await logEmailActivity(
    schedule,
    ACTIVITY_TYPES.EMAIL_CANCELLED,
    `Email cancelled: "${schedule.subject}"`
  );

  return schedule;
}

export async function sendInviteEmail({
  to,
  inviteLink,
  organizationName,
  roleLabel,
  inviterName,
}) {
  const subject = `${inviterName} invited you to ${organizationName}`;

  const text = [
    'You\'re invited to bestechVison AI CRM',
    '',
    `${inviterName} has invited you to join ${organizationName} as ${roleLabel}.`,
    '',
    'Accept your invitation:',
    inviteLink,
    '',
    'This invitation expires in 7 days.',
    '',
    '— bestechVison AI CRM',
  ].join('\n');

  const html = `
    <div style="font-family: sans-serif; line-height: 1.6; max-width: 560px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #2013d1; margin-bottom: 8px;">You're invited!</h2>
      <p>Hi,</p>
      <p>
        <strong>${inviterName}</strong> has invited you to join
        <strong>${organizationName}</strong> on bestechVison AI CRM as <strong>${roleLabel}</strong>.
      </p>
      <p>Click the button below to create your account and join the team:</p>
      <p style="margin: 28px 0;">
        <a href="${inviteLink}"
           style="background: #2013d1; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
          Accept invitation
        </a>
      </p>
      <p style="font-size: 14px; color: #64748b;">
        Or copy this link into your browser:<br>
        <a href="${inviteLink}" style="color: #2013d1; word-break: break-all;">${inviteLink}</a>
      </p>
      <p style="font-size: 14px; color: #64748b;">This invitation expires in 7 days.</p>
      <p style="font-size: 14px; color: #94a3b8; margin-top: 32px;">— bestechVison AI CRM</p>
    </div>
  `;

  if (!getResend()) {
    return {
      sent: false,
      demo: true,
      message: `Demo mode — email not sent. Copy the invite link and share it with ${to}.`,
    };
  }

  const replyTo = process.env.INVITE_REPLY_TO?.trim() || process.env.SUPPORT_EMAIL?.trim();

  const delivery = await deliverViaResend({ to, subject, html, text, replyTo });

  if (!delivery.ok) {
    console.error(`Invite email failed for ${to}:`, delivery.message);
    const sandboxHint =
      isSandboxSender() || delivery.message.includes('testing emails to your own email')
        ? ' Verify your domain in Resend and set EMAIL_FROM to an address on that domain (e.g. invites@bestechvision.com).'
        : '';
    return {
      sent: false,
      demo: false,
      message: `${delivery.message}${sandboxHint} Copy the invite link below.`,
    };
  }

  console.log(`Invite email sent to ${to} (id: ${delivery.id})`);

  return {
    sent: true,
    demo: false,
    message: delivery.message,
  };
}
