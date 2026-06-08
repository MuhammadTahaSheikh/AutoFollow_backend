import pool from '../config/db.js';
import { logActivity } from './activity.js';
import { ACTIVITY_TYPES } from '../utils/activityTypes.js';

function toMysqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function applyTemplate(template, lead) {
  return template
    .replace(/\{\{name\}\}/gi, lead.name)
    .replace(/\{\{email\}\}/gi, lead.email);
}

export async function getSequences(user) {
  const [sequences] = await pool.query(
    `SELECT * FROM follow_up_sequences
     WHERE organization_id = ?
     ORDER BY created_at DESC`,
    [user.organization_id]
  );

  if (sequences.length === 0) return [];

  const ids = sequences.map((s) => s.id);
  const [steps] = await pool.query(
    `SELECT * FROM follow_up_steps WHERE sequence_id IN (?) ORDER BY step_number ASC`,
    [ids]
  );

  const stepsBySeq = {};
  for (const step of steps) {
    if (!stepsBySeq[step.sequence_id]) stepsBySeq[step.sequence_id] = [];
    stepsBySeq[step.sequence_id].push(step);
  }

  return sequences.map((seq) => ({
    ...seq,
    steps: stepsBySeq[seq.id] || [],
  }));
}

export async function getSequence(user, sequenceId) {
  const [rows] = await pool.query(
    `SELECT * FROM follow_up_sequences WHERE id = ? AND organization_id = ?`,
    [sequenceId, user.organization_id]
  );

  if (rows.length === 0) return null;

  const [steps] = await pool.query(
    `SELECT * FROM follow_up_steps WHERE sequence_id = ? ORDER BY step_number ASC`,
    [sequenceId]
  );

  return { ...rows[0], steps };
}

async function syncSteps(connection, sequenceId, steps) {
  await connection.query(`DELETE FROM follow_up_steps WHERE sequence_id = ?`, [sequenceId]);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    await connection.query(
      `INSERT INTO follow_up_steps (sequence_id, step_number, delay_hours, subject, message_template)
       VALUES (?, ?, ?, ?, ?)`,
      [
        sequenceId,
        step.step_number ?? i + 1,
        step.delay_hours,
        step.subject,
        step.message_template,
      ]
    );
  }
}

export async function createSequence(user, { name, is_active = true, steps = [] }) {
  if (!name?.trim()) throw new Error('Sequence name is required');
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('At least one step is required');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO follow_up_sequences (organization_id, name, is_active) VALUES (?, ?, ?)`,
      [user.organization_id, name.trim(), is_active ? 1 : 0]
    );

    await syncSteps(connection, result.insertId, steps);
    await connection.commit();

    return getSequence(user, result.insertId);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function updateSequence(user, sequenceId, { name, is_active, steps }) {
  const existing = await getSequence(user, sequenceId);
  if (!existing) throw new Error('Sequence not found');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE follow_up_sequences SET
        name = COALESCE(?, name),
        is_active = COALESCE(?, is_active)
       WHERE id = ? AND organization_id = ?`,
      [
        name?.trim() || null,
        is_active !== undefined ? (is_active ? 1 : 0) : null,
        sequenceId,
        user.organization_id,
      ]
    );

    if (Array.isArray(steps) && steps.length > 0) {
      await syncSteps(connection, sequenceId, steps);
    }

    await connection.commit();
    return getSequence(user, sequenceId);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function deleteSequence(user, sequenceId) {
  const existing = await getSequence(user, sequenceId);
  if (!existing) throw new Error('Sequence not found');

  await pool.query(
    `DELETE FROM follow_up_sequences WHERE id = ? AND organization_id = ?`,
    [sequenceId, user.organization_id]
  );

  return { message: 'Sequence deleted successfully' };
}

export async function attachDefaultSequenceToLead(user, lead) {
  const [sequences] = await pool.query(
    `SELECT id, name FROM follow_up_sequences
     WHERE organization_id = ? AND is_active = 1
     ORDER BY created_at ASC
     LIMIT 1`,
    [user.organization_id]
  );

  if (sequences.length === 0) return [];

  const sequence = sequences[0];
  const [steps] = await pool.query(
    `SELECT * FROM follow_up_steps WHERE sequence_id = ? ORDER BY step_number ASC`,
    [sequence.id]
  );

  if (steps.length === 0) return [];

  const createdAt = new Date(lead.created_at || Date.now());
  const scheduled = [];

  for (const step of steps) {
    const scheduledAt = new Date(createdAt.getTime() + step.delay_hours * 60 * 60 * 1000);
    const subject = applyTemplate(step.subject, lead);
    const body = applyTemplate(step.message_template, lead);

    const [emailResult] = await pool.query(
      `INSERT INTO email_schedules (user_id, lead_id, subject, body, scheduled_at)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, lead.id, subject, body, toMysqlUtc(scheduledAt)]
    );

    await pool.query(
      `INSERT INTO lead_follow_ups (lead_id, step_id, scheduled_at, status)
       VALUES (?, ?, ?, 'pending')`,
      [lead.id, step.id, toMysqlUtc(scheduledAt)]
    );

    await logActivity(pool, {
      organizationId: user.organization_id,
      leadId: lead.id,
      userId: user.id,
      activityType: ACTIVITY_TYPES.FOLLOW_UP_SCHEDULED,
      description: `Follow-up step ${step.step_number} scheduled for ${lead.name}`,
      metadata: {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        stepNumber: step.step_number,
        delayHours: step.delay_hours,
        emailScheduleId: emailResult.insertId,
      },
    });

    await logActivity(pool, {
      organizationId: user.organization_id,
      leadId: lead.id,
      userId: user.id,
      activityType: ACTIVITY_TYPES.EMAIL_SCHEDULED,
      description: `Email scheduled: "${subject}"`,
      metadata: {
        emailScheduleId: emailResult.insertId,
        scheduledAt: toMysqlUtc(scheduledAt),
        source: 'follow_up_sequence',
      },
    });

    scheduled.push({ step, scheduledAt, emailScheduleId: emailResult.insertId });
  }

  return scheduled;
}

export async function getLeadFollowUps(user, leadId) {
  const [rows] = await pool.query(
    `SELECT lf.*, fs.step_number, fs.delay_hours, fs.subject, seq.name as sequence_name
     FROM lead_follow_ups lf
     JOIN follow_up_steps fs ON fs.id = lf.step_id
     JOIN follow_up_sequences seq ON seq.id = fs.sequence_id
     JOIN leads l ON l.id = lf.lead_id
     WHERE lf.lead_id = ? AND l.organization_id = ?
     ORDER BY lf.scheduled_at ASC`,
    [leadId, user.organization_id]
  );

  return rows;
}
