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
import { assertWithinLimit, handleUsageLimitError } from '../services/usage.js';
import { getPlanLimits } from '../config/plans.js';

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
       WHERE organization_id = ? AND role IN ('user', 'admin') AND id IN (?)`,
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
       WHERE organization_id = ? AND role IN ('user', 'admin')
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
    const withAssignees = await attachAssignees(leads);
    res.json({ leads: withAssignees });
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

function normalizeLeadEmail(email) {
  return String(email).trim().toLowerCase();
}

function isWeakImportName(name) {
  if (!name) return true;
  const normalized = String(name).trim().toLowerCase();
  return (
    normalized === 'not given' ||
    normalized === 'n/a' ||
    normalized === 'na' ||
    normalized === 'unknown' ||
    normalized === '-'
  );
}

function pickImportName(...candidates) {
  for (const candidate of candidates) {
    if (candidate && !isWeakImportName(candidate)) return String(candidate).trim();
  }
  for (const candidate of candidates) {
    if (candidate && String(candidate).trim()) return String(candidate).trim();
  }
  return '';
}

function pickImportSource(current, incoming) {
  const isUrl = (value) => value && /^https?:\/\//i.test(String(value));
  if (isUrl(incoming) && !isUrl(current)) return incoming;
  if (isUrl(current)) return current;
  return incoming || current || null;
}

function appendImportNote(existing, addition) {
  const next = addition ? String(addition).trim() : '';
  if (!next) return existing || null;
  if (!existing || !String(existing).trim()) return next;
  if (String(existing).includes(next)) return existing;
  return `${String(existing).trim()}\n${next}`;
}

function mergeImportLeadFields(existing, incoming) {
  return {
    name: pickImportName(existing.name, incoming.name) || existing.name || incoming.name,
    phone: existing.phone || incoming.phone || null,
    source: pickImportSource(existing.source, incoming.source) || incoming.source || existing.source || 'csv',
    notes: appendImportNote(existing.notes, incoming.notes),
    team_member_name: existing.team_member_name || incoming.team_member_name || null,
  };
}

function parseTeamMemberTokens(value) {
  if (!value || !String(value).trim()) return [];
  return String(value)
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizePersonName(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveTeamMemberIds(teamMemberValue, assignableUsers) {
  const tokens = parseTeamMemberTokens(teamMemberValue);
  if (tokens.length === 0) {
    return { userIds: [], notFound: [] };
  }

  const userIds = [];
  const notFound = [];

  for (const token of tokens) {
    const lower = token.toLowerCase().trim();
    const normalizedToken = normalizePersonName(token);

    const byEmail = assignableUsers.find((user) => user.email.toLowerCase() === lower);
    if (byEmail) {
      userIds.push(byEmail.id);
      continue;
    }

    const byName = assignableUsers.find(
      (user) => normalizePersonName(user.name) === normalizedToken
    );
    if (byName) {
      userIds.push(byName.id);
      continue;
    }

    const partialMatches = assignableUsers.filter((user) => {
      const normalizedName = normalizePersonName(user.name);
      return (
        normalizedName.includes(normalizedToken) || normalizedToken.includes(normalizedName)
      );
    });
    if (partialMatches.length === 1) {
      userIds.push(partialMatches[0].id);
      continue;
    }

    notFound.push(token);
  }

  return { userIds: [...new Set(userIds)], notFound };
}

router.post('/import', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { leads: leadsData } = req.body;

    if (!Array.isArray(leadsData) || leadsData.length === 0) {
      return res.status(400).json({ error: 'leads array is required' });
    }

    const [existingRows] = await pool.query(
      'SELECT LOWER(TRIM(email)) AS email FROM leads WHERE organization_id = ?',
      [req.user.organization_id]
    );
    const existingEmails = new Set(existingRows.map((row) => row.email));
    const batchLeadsByEmail = new Map();

    const countImportableRows = () => {
      const batchEmails = new Set();
      let count = 0;

      for (const row of leadsData) {
        const { name, email, status } = row || {};
        if (!name || !email) continue;
        if (status && !VALID_STATUSES.includes(status)) continue;

        const normalizedEmail = normalizeLeadEmail(email);
        if (existingEmails.has(normalizedEmail) || batchEmails.has(normalizedEmail)) {
          continue;
        }

        batchEmails.add(normalizedEmail);
        count++;
      }

      return count;
    };

    if (req.user.organization_id) {
      const [orgRows] = await pool.query('SELECT plan FROM organizations WHERE id = ?', [
        req.user.organization_id,
      ]);
      const planId = orgRows[0]?.plan || 'free';
      const limits = getPlanLimits(planId);
      const [countRows] = await pool.query(
        'SELECT COUNT(*) AS count FROM leads WHERE organization_id = ?',
        [req.user.organization_id]
      );
      const used = countRows[0].count;
      const remaining = limits.leads - used;
      const importableCount = countImportableRows();

      if (remaining <= 0 && importableCount > 0) {
        await assertWithinLimit(req.user.organization_id, 'leads');
      }

      if (importableCount > remaining) {
        return res.status(403).json({
          error: `Cannot import ${importableCount} new leads. You have ${remaining} lead slot(s) remaining on your plan.`,
          code: 'USAGE_LIMIT_EXCEEDED',
          metric: 'leads',
          used,
          limit: limits.leads,
          plan: planId,
        });
      }
    }

    const errors = [];
    const createdLeadIds = [];
    const pendingAssignments = [];
    let imported = 0;
    let failed = 0;
    let skipped = 0;
    let merged = 0;

    let assignableUsers = [];
    if (isLeadManager(req.user.role)) {
      const [users] = await pool.query(
        `SELECT id, name, email FROM users
         WHERE organization_id = ? AND role IN ('user', 'admin')
         ORDER BY name ASC`,
        [req.user.organization_id]
      );
      assignableUsers = users;
    }

    await connection.beginTransaction();

    for (let i = 0; i < leadsData.length; i++) {
      const row = leadsData[i];
      const rowNum = i + 1;
      const { name, email, phone, source, status, notes, team_member } = row || {};

      if (!name || !email) {
        failed++;
        errors.push(`Row ${rowNum}: name and email are required.`);
        continue;
      }

      if (status && !VALID_STATUSES.includes(status)) {
        failed++;
        errors.push(`Row ${rowNum}: invalid status "${status}".`);
        continue;
      }

      const normalizedEmail = normalizeLeadEmail(email);
      const teamMemberLabel = team_member ? String(team_member).trim() : null;
      const incomingLead = {
        name,
        email,
        phone: phone || null,
        source: source || 'csv',
        status: status || 'new',
        notes: notes || null,
        team_member_name: teamMemberLabel,
      };

      if (existingEmails.has(normalizedEmail)) {
        const [existingLeadRows] = await connection.query(
          'SELECT id, name, phone, source, notes, team_member_name FROM leads WHERE organization_id = ? AND LOWER(TRIM(email)) = ? LIMIT 1',
          [req.user.organization_id, normalizedEmail]
        );
        const existingLead = existingLeadRows[0];
        if (existingLead) {
          const mergedFields = mergeImportLeadFields(existingLead, incomingLead);
          await connection.query(
            `UPDATE leads
             SET name = ?, phone = ?, source = ?, notes = ?, team_member_name = ?
             WHERE id = ?`,
            [
              mergedFields.name,
              mergedFields.phone,
              mergedFields.source,
              mergedFields.notes,
              mergedFields.team_member_name,
              existingLead.id,
            ]
          );

          if (teamMemberLabel && isLeadManager(req.user.role)) {
            const { userIds } = resolveTeamMemberIds(teamMemberLabel, assignableUsers);
            if (userIds.length > 0) {
              pendingAssignments.push({ leadId: existingLead.id, userIds });
            }
          }

          merged++;
        } else {
          skipped++;
          errors.push(`Row ${rowNum}: skipped duplicate lead (${email}).`);
        }
        continue;
      }

      if (batchLeadsByEmail.has(normalizedEmail)) {
        const existingBatchLead = batchLeadsByEmail.get(normalizedEmail);
        const mergedFields = mergeImportLeadFields(existingBatchLead, incomingLead);
        await connection.query(
          `UPDATE leads
           SET name = ?, phone = ?, source = ?, notes = ?, team_member_name = ?
           WHERE id = ?`,
          [
            mergedFields.name,
            mergedFields.phone,
            mergedFields.source,
            mergedFields.notes,
            mergedFields.team_member_name,
            existingBatchLead.id,
          ]
        );
        batchLeadsByEmail.set(normalizedEmail, { ...existingBatchLead, ...mergedFields });
        merged++;
        continue;
      }

      existingEmails.add(normalizedEmail);

      const [result] = await connection.query(
        `INSERT INTO leads (user_id, organization_id, name, email, phone, source, status, notes, team_member_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          req.user.organization_id,
          incomingLead.name,
          incomingLead.email,
          incomingLead.phone,
          incomingLead.source,
          incomingLead.status,
          incomingLead.notes,
          incomingLead.team_member_name,
        ]
      );

      const leadId = result.insertId;
      createdLeadIds.push(leadId);
      batchLeadsByEmail.set(normalizedEmail, { id: leadId, ...incomingLead });

      if (!isLeadManager(req.user.role)) {
        await connection.query(
          `INSERT INTO lead_assignments (lead_id, user_id, assigned_by) VALUES (?, ?, ?)`,
          [leadId, req.user.id, req.user.id]
        );
      } else if (teamMemberLabel) {
        const { userIds, notFound } = resolveTeamMemberIds(teamMemberLabel, assignableUsers);
        if (notFound.length > 0 && userIds.length === 0) {
          errors.push(
            `Row ${rowNum}: team member "${teamMemberLabel}" saved on lead (invite them from Members to link assignments).`
          );
        } else if (notFound.length > 0) {
          errors.push(`Row ${rowNum}: some team members not found; label saved on lead.`);
        }
        if (userIds.length > 0) {
          pendingAssignments.push({ leadId, userIds });
        }
      }

      imported++;
    }

    await connection.commit();

    for (const { leadId, userIds } of pendingAssignments) {
      await syncAssignments(
        leadId,
        userIds,
        req.user.id,
        req.user.organization_id,
        req.user
      );
    }

    for (const leadId of createdLeadIds) {
      const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
      const lead = leads[0];
      if (!lead) continue;

      await logActivity(pool, {
        organizationId: req.user.organization_id,
        leadId: lead.id,
        userId: req.user.id,
        activityType: ACTIVITY_TYPES.LEAD_CREATED,
        description: `Lead imported: ${lead.name}`,
        metadata: { email: lead.email, source: lead.source, status: lead.status, import: true },
      });

      await attachDefaultSequenceToLead(req.user, lead);
    }

    res.status(201).json({ imported, merged, failed, skipped, errors });
  } catch (err) {
    await connection.rollback();
    if (handleUsageLimitError(err, res)) return;
    console.error('Import leads error:', err);
    res.status(500).json({ error: 'Failed to import leads' });
  } finally {
    connection.release();
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

    if (req.user.organization_id) {
      await assertWithinLimit(req.user.organization_id, 'leads');
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
    if (handleUsageLimitError(err, res)) return;
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
