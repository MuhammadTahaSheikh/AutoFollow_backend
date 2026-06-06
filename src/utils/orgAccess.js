import pool from '../config/db.js';

export async function loadUserAccount(userId) {
  const [users] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name
     FROM users u
     LEFT JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = ?`,
    [userId]
  );
  return users[0] || null;
}

export async function getLeadForOrg(leadId, organizationId) {
  const [leads] = await pool.query(
    'SELECT * FROM leads WHERE id = ? AND organization_id = ?',
    [leadId, organizationId]
  );
  return leads[0] || null;
}

export function formatUserResponse(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organization_id: user.organization_id,
    organization_name: user.organization_name || null,
  };
}
