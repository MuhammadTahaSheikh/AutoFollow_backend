import { Resend } from 'resend';
import pool from '../config/db.js';

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

/** Store datetimes in UTC so MySQL comparisons stay correct across timezones */
function toMysqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function scheduleEmail(userId, { leadId, subject, body, scheduledAt }) {
  const [leads] = await pool.query(
    'SELECT * FROM leads WHERE id = ? AND user_id = ?',
    [leadId, userId]
  );

  if (leads.length === 0) {
    throw new Error('Lead not found');
  }

  const [result] = await pool.query(
    `INSERT INTO email_schedules (user_id, lead_id, subject, body, scheduled_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, leadId, subject, body, toMysqlUtc(scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt))]
  );

  const [rows] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function sendEmailNow(userId, { leadId, subject, body }) {
  const [leads] = await pool.query(
    'SELECT * FROM leads WHERE id = ? AND user_id = ?',
    [leadId, userId]
  );

  if (leads.length === 0) {
    throw new Error('Lead not found');
  }

  const lead = leads[0];
  const [result] = await pool.query(
    `INSERT INTO email_schedules (user_id, lead_id, subject, body, scheduled_at, status)
     VALUES (?, ?, ?, ?, NOW(), 'pending')`,
    [userId, leadId, subject, body]
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
    await getResend().emails.send({
      from: getEmailFrom(),
      to: schedule.lead_email,
      subject: schedule.subject,
      html: `<div style="font-family: sans-serif; line-height: 1.6;">${schedule.body.replace(/\n/g, '<br>')}</div>`,
    });

    await pool.query(
      `UPDATE email_schedules SET status = 'sent', sent_at = NOW() WHERE id = ?`,
      [scheduleId]
    );

    const [updated] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [scheduleId]);
    return {
      ...updated[0],
      demo: false,
      recipient: schedule.lead_email,
      message: `Email sent to ${schedule.lead_email}`,
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

export async function getEmailSchedules(userId, leadId) {
  const query = leadId
    ? 'SELECT es.*, l.name as lead_name, l.email as lead_email FROM email_schedules es JOIN leads l ON es.lead_id = l.id WHERE es.user_id = ? AND es.lead_id = ? ORDER BY es.scheduled_at DESC'
    : 'SELECT es.*, l.name as lead_name, l.email as lead_email FROM email_schedules es JOIN leads l ON es.lead_id = l.id WHERE es.user_id = ? ORDER BY es.scheduled_at DESC';

  const params = leadId ? [userId, leadId] : [userId];
  const [schedules] = await pool.query(query, params);
  return schedules;
}

export async function cancelEmail(userId, scheduleId) {
  const [result] = await pool.query(
    `UPDATE email_schedules SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [scheduleId, userId]
  );

  if (result.affectedRows === 0) {
    throw new Error('Email schedule not found or already processed');
  }

  const [rows] = await pool.query('SELECT * FROM email_schedules WHERE id = ?', [scheduleId]);
  return rows[0];
}
