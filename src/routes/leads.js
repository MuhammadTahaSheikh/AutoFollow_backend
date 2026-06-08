import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  canAccessLead,
  fetchLeadAssignees,
  isLeadManager,
  leadListFilter,
} from '../utils/leadAccess.js';
import { logActivity } from '../services/activity.js';
import { ACTIVITY_TYPES } from '../utils/activityTypes.js';
import { attachDefaultSequenceToLead } from '../services/sequences.js';

const router = Router();
router.use(authenticate);

const VALID_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

async function attachAssignees(leads) {
  if (leads.length === 0) return leads;

  const ids = leads.map((l) => l.id);
  const [rows] = await pool.query(
    `SELECT la.lead_id, u.id, u.name, u.email, u.role
     FROM lead_assignments la
     JOIN users u ON u.id = la.user_id
     WHERE la.lead_id IN (?)
     ORDER BY u.name ASC`,
    [ids]
  );

  const byLead = {};
  for (const row of rows) {
    if (!byLead[row.lead_id]) byLead[row.lead_id] = [];
    byLead[row.lead_id].push({ id: row.id, name: row.name, email: row.email, role: row.role });
  }

  return leads.map((lead) => ({
    ...lead,
    assignees: byLead[lead.id] || [],
  }));
}

async function syncAssignments(leadId, userIds, assignedBy, organizationId, actorUser) {
  const uniqueIds = [...new Set(userIds.map((id) => parseInt(id, 10)).filter(Boolean))];

  let validIds = [];
  if (uniqueIds.length > 0) {
    const [validUsers] = await pool.query(
      `SELECT id, name FROM users
       WHERE organization_id = ? AND role = 'user' AND id IN (?)`,
      [organizationId, uniqueIds]
    );
    validIds = validUsers.map((u) => u.id);
  }

  await pool.query('DELETE FROM lead_assignments WHERE lead_id = ?', [leadId]);

  for (const userId of validIds) {
    await pool.query(
      `INSERT INTO lead_assignments (lead_id, user_id, assigned_by) VALUES (?, ?, ?)`,
      [leadId, userId, assignedBy]
    );
  }

  if (actorUser && validIds.length > 0) {
    const [leadRows] = await pool.query('SELECT name FROM leads WHERE id = ?', [leadId]);
    const leadName = leadRows[0]?.name || 'lead';
    await logActivity(pool, {
      organizationId,
      leadId,
      userId: actorUser.id,
      activityType: ACTIVITY_TYPES.LEAD_ASSIGNED,
      description: `Lead assigned: ${leadName}`,
      metadata: { assignedUserIds: validIds },
    });
  }

  return fetchLeadAssignees(pool, leadId);
}

router.get('/assignable-users', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, name, email, role FROM users
       WHERE organization_id = ? AND role = 'user'
       ORDER BY name ASC`,
      [req.user.organization_id]
    );
    res.json({ users });
  } catch (err) {
    console.error('Assignable users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = leadListFilter(req.user, 'l');

    let query = `SELECT l.* FROM leads l WHERE ${filter.where}`;
    const params = [...filter.params];

    if (status && VALID_STATUSES.includes(status)) {
      query += ' AND l.status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    query += ' ORDER BY l.created_at DESC';

    const [leads] = await pool.query(query, params);

    if (isLeadManager(req.user.role)) {
      const withAssignees = await attachAssignees(leads);
      return res.json({ leads: withAssignees });
    }

    res.json({ leads });
  } catch (err) {
    console.error('Get leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const filter = leadListFilter(req.user, 'l');
    const [rows] = await pool.query(
      `SELECT l.status, COUNT(*) as count FROM leads l
       WHERE ${filter.where}
       GROUP BY l.status`,
      filter.params
    );

    const stats = { total: 0, new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 };
    for (const row of rows) {
      stats[row.status] = row.count;
      stats.total += row.count;
    }

    res.json({ stats });
  } catch (err) {
    console.error('Lead stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/:id/assignments', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const lead = await canAccessLead(pool, req.user, req.params.id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const assignees = await fetchLeadAssignees(pool, lead.id);
    res.json({ assignees });
  } catch (err) {
    console.error('Get assignments error:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

router.put('/:id/assignments', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { userIds = [] } = req.body;
    const lead = await canAccessLead(pool, req.user, req.params.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (!Array.isArray(userIds)) {
      return res.status(400).json({ error: 'userIds must be an array' });
    }

    const assignees = await syncAssignments(
      lead.id,
      userIds,
      req.user.id,
      req.user.organization_id,
      req.user
    );

    res.json({ assignees });
  } catch (err) {
    if (err.message === 'One or more selected users are invalid') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Update assignments error:', err);
    res.status(500).json({ error: 'Failed to update assignments' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const lead = await canAccessLead(pool, req.user, req.params.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (isLeadManager(req.user.role)) {
      const assignees = await fetchLeadAssignees(pool, lead.id);
      return res.json({ lead: { ...lead, assignees } });
    }

    res.json({ lead });
  } catch (err) {
    console.error('Get lead error:', err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

router.post('/', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { name, email, phone, source, status, notes, assignedUserIds } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO leads (user_id, organization_id, name, email, phone, source, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        req.user.organization_id,
        name,
        email,
        phone || null,
        source || 'manual',
        status || 'new',
        notes || null,
      ]
    );

    const leadId = result.insertId;

    if (!isLeadManager(req.user.role)) {
      await connection.query(
        `INSERT INTO lead_assignments (lead_id, user_id, assigned_by) VALUES (?, ?, ?)`,
        [leadId, req.user.id, req.user.id]
      );
    }

    await connection.commit();

    if (isLeadManager(req.user.role) && Array.isArray(assignedUserIds) && assignedUserIds.length > 0) {
      await syncAssignments(
        leadId,
        assignedUserIds,
        req.user.id,
        req.user.organization_id,
        req.user
      );
    }

    const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    let lead = leads[0];

    await logActivity(pool, {
      organizationId: req.user.organization_id,
      leadId,
      userId: req.user.id,
      activityType: ACTIVITY_TYPES.LEAD_CREATED,
      description: `Lead created: ${lead.name}`,
      metadata: { email: lead.email, source: lead.source, status: lead.status },
    });

    await attachDefaultSequenceToLead(req.user, lead);

    if (isLeadManager(req.user.role)) {
      const assignees = await fetchLeadAssignees(pool, leadId);
      lead = { ...lead, assignees };
    }

    res.status(201).json({ lead });
  } catch (err) {
    await connection.rollback();
    console.error('Create lead error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  } finally {
    connection.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, email, phone, source, status, notes, assignedUserIds } = req.body;

    const lead = await canAccessLead(pool, req.user, req.params.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (status && status !== lead.status) {
      await logActivity(pool, {
        organizationId: req.user.organization_id,
        leadId: lead.id,
        userId: req.user.id,
        activityType: ACTIVITY_TYPES.LEAD_STATUS_CHANGED,
        description: `Status changed from ${lead.status} to ${status}`,
        metadata: { from: lead.status, to: status },
      });
    }

    await pool.query(
      `UPDATE leads SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes)
       WHERE id = ? AND organization_id = ?`,
      [name, email, phone, source, status, notes, req.params.id, req.user.organization_id]
    );

    await logActivity(pool, {
      organizationId: req.user.organization_id,
      leadId: lead.id,
      userId: req.user.id,
      activityType: ACTIVITY_TYPES.LEAD_UPDATED,
      description: `Lead updated: ${name || lead.name}`,
    });

    if (
      isLeadManager(req.user.role) &&
      Array.isArray(assignedUserIds)
    ) {
      await syncAssignments(
        lead.id,
        assignedUserIds,
        req.user.id,
        req.user.organization_id,
        req.user
      );
    }

    const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    let updated = leads[0];

    if (isLeadManager(req.user.role)) {
      const assignees = await fetchLeadAssignees(pool, lead.id);
      updated = { ...updated, assignees };
    }

    res.json({ lead: updated });
  } catch (err) {
    if (err.message === 'One or more selected users are invalid') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

router.delete('/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const lead = await canAccessLead(pool, req.user, req.params.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    await logActivity(pool, {
      organizationId: req.user.organization_id,
      leadId: lead.id,
      userId: req.user.id,
      activityType: ACTIVITY_TYPES.LEAD_DELETED,
      description: `Lead deleted: ${lead.name}`,
      metadata: { email: lead.email },
    });

    await pool.query('DELETE FROM leads WHERE id = ?', [req.params.id]);

    res.json({ message: 'Lead deleted successfully' });
  } catch (err) {
    console.error('Delete lead error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

export default router;
