import pool from '../config/db.js';
import { canAccessLead, leadListFilter } from '../utils/leadAccess.js';

export async function logActivity(
  db,
  { organizationId, leadId = null, userId, activityType, description, metadata = null }
) {
  const conn = db || pool;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const [result] = await conn.query(
    `INSERT INTO activities (organization_id, lead_id, user_id, activity_type, description, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [organizationId, leadId, userId, activityType, description, metadataJson]
  );

  const [rows] = await conn.query('SELECT * FROM activities WHERE id = ?', [result.insertId]);
  return rows[0];
}

export async function getActivitiesForLead(user, leadId) {
  const lead = await canAccessLead(pool, user, leadId);
  if (!lead) {
    throw new Error('Lead not found');
  }

  const [activities] = await pool.query(
    `SELECT a.*, u.name as user_name, u.email as user_email
     FROM activities a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.lead_id = ? AND a.organization_id = ?
     ORDER BY a.created_at DESC`,
    [leadId, user.organization_id]
  );

  return activities.map(formatActivity);
}

export async function getActivitiesForOrganization(user) {
  const filter = leadListFilter(user, 'l');

  const [activities] = await pool.query(
    `SELECT a.*, u.name as user_name, u.email as user_email, l.name as lead_name
     FROM activities a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.organization_id = ?
       AND (a.lead_id IS NULL OR EXISTS (
         SELECT 1 FROM leads l2 WHERE l2.id = a.lead_id AND ${filter.where.replace(/\bl\./g, 'l2.')}
       ))
     ORDER BY a.created_at DESC
     LIMIT 200`,
    [user.organization_id, ...filter.params]
  );

  return activities.map(formatActivity);
}

function formatActivity(row) {
  let metadata = null;
  if (row.metadata_json) {
    try {
      metadata = typeof row.metadata_json === 'string'
        ? JSON.parse(row.metadata_json)
        : row.metadata_json;
    } catch {
      metadata = null;
    }
  }

  return {
    ...row,
    metadata,
    metadata_json: undefined,
  };
}
