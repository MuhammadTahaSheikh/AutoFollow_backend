export function isLeadManager(role) {
  return role === 'super_admin' || role === 'admin';
}

export function leadListFilter(user, alias = 'l') {
  if (isLeadManager(user.role)) {
    return {
      where: `${alias}.organization_id = ?`,
      params: [user.organization_id],
    };
  }

  return {
    where: `${alias}.organization_id = ? AND EXISTS (
      SELECT 1 FROM lead_assignments la
      WHERE la.lead_id = ${alias}.id AND la.user_id = ?
    )`,
    params: [user.organization_id, user.id],
  };
}

export async function canAccessLead(pool, user, leadId) {
  if (isLeadManager(user.role)) {
    const [rows] = await pool.query(
      'SELECT * FROM leads WHERE id = ? AND organization_id = ?',
      [leadId, user.organization_id]
    );
    return rows[0] || null;
  }

  const [rows] = await pool.query(
    `SELECT l.* FROM leads l
     INNER JOIN lead_assignments la ON la.lead_id = l.id AND la.user_id = ?
     WHERE l.id = ? AND l.organization_id = ?`,
    [user.id, leadId, user.organization_id]
  );
  return rows[0] || null;
}

export async function fetchLeadAssignees(pool, leadId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, la.created_at AS assigned_at
     FROM lead_assignments la
     JOIN users u ON u.id = la.user_id
     WHERE la.lead_id = ?
     ORDER BY u.name ASC`,
    [leadId]
  );
  return rows;
}
