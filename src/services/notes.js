import pool from '../config/db.js';
import { canAccessLead } from '../utils/leadAccess.js';
import { logActivity } from './activity.js';
import { ACTIVITY_TYPES } from '../utils/activityTypes.js';

export async function createNote(user, { leadId, note }) {
  const lead = await canAccessLead(pool, user, leadId);
  if (!lead) throw new Error('Lead not found');

  const [result] = await pool.query(
    `INSERT INTO lead_notes (lead_id, user_id, note) VALUES (?, ?, ?)`,
    [leadId, user.id, note]
  );

  const [rows] = await pool.query(
    `SELECT ln.*, u.name as author_name, u.email as author_email
     FROM lead_notes ln
     JOIN users u ON u.id = ln.user_id
     WHERE ln.id = ?`,
    [result.insertId]
  );

  await logActivity(pool, {
    organizationId: user.organization_id,
    leadId,
    userId: user.id,
    activityType: ACTIVITY_TYPES.NOTE_ADDED,
    description: `Note added for ${lead.name}`,
    metadata: { noteId: result.insertId },
  });

  return rows[0];
}

export async function getNotesForLead(user, leadId) {
  const lead = await canAccessLead(pool, user, leadId);
  if (!lead) throw new Error('Lead not found');

  const [notes] = await pool.query(
    `SELECT ln.*, u.name as author_name, u.email as author_email
     FROM lead_notes ln
     JOIN users u ON u.id = ln.user_id
     WHERE ln.lead_id = ?
     ORDER BY ln.created_at DESC`,
    [leadId]
  );

  return notes;
}

export async function updateNote(user, noteId, noteText) {
  const [existing] = await pool.query(
    `SELECT ln.*, l.organization_id, l.name as lead_name
     FROM lead_notes ln
     JOIN leads l ON l.id = ln.lead_id
     WHERE ln.id = ? AND l.organization_id = ?`,
    [noteId, user.organization_id]
  );

  if (existing.length === 0) throw new Error('Note not found');

  const note = existing[0];
  await canAccessLead(pool, user, note.lead_id);

  if (note.user_id !== user.id) {
    throw new Error('You can only edit your own notes');
  }

  await pool.query(`UPDATE lead_notes SET note = ? WHERE id = ?`, [noteText, noteId]);

  const [rows] = await pool.query(
    `SELECT ln.*, u.name as author_name, u.email as author_email
     FROM lead_notes ln
     JOIN users u ON u.id = ln.user_id
     WHERE ln.id = ?`,
    [noteId]
  );

  await logActivity(pool, {
    organizationId: user.organization_id,
    leadId: note.lead_id,
    userId: user.id,
    activityType: ACTIVITY_TYPES.NOTE_UPDATED,
    description: `Note updated for ${note.lead_name}`,
    metadata: { noteId },
  });

  return rows[0];
}

export async function deleteNote(user, noteId) {
  const [existing] = await pool.query(
    `SELECT ln.*, l.organization_id, l.name as lead_name
     FROM lead_notes ln
     JOIN leads l ON l.id = ln.lead_id
     WHERE ln.id = ? AND l.organization_id = ?`,
    [noteId, user.organization_id]
  );

  if (existing.length === 0) throw new Error('Note not found');

  const note = existing[0];
  await canAccessLead(pool, user, note.lead_id);

  if (note.user_id !== user.id) {
    throw new Error('You can only delete your own notes');
  }

  await pool.query(`DELETE FROM lead_notes WHERE id = ?`, [noteId]);

  await logActivity(pool, {
    organizationId: user.organization_id,
    leadId: note.lead_id,
    userId: user.id,
    activityType: ACTIVITY_TYPES.NOTE_DELETED,
    description: `Note deleted for ${note.lead_name}`,
    metadata: { noteId },
  });

  return { message: 'Note deleted successfully' };
}
