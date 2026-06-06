import { Router } from 'express';
import crypto from 'crypto';
import pool from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { canChangeMemberRole, canInviteRole, ROLE_LABELS, ROLES } from '../utils/roles.js';
import { sendInviteEmail } from '../services/email.js';

const router = Router();
router.use(authenticate);

router.get('/', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [members] = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE organization_id = ?
       ORDER BY FIELD(role, 'super_admin', 'admin', 'user'), name ASC`,
      [req.user.organization_id]
    );

    res.json({ members });
  } catch (err) {
    console.error('List members error:', err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

router.get('/invitations', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [invitations] = await pool.query(
      `SELECT i.id, i.email, i.role, i.token, i.status, i.expires_at, i.created_at,
              u.name AS invited_by_name
       FROM invitations i
       JOIN users u ON u.id = i.invited_by
       WHERE i.organization_id = ? AND i.status = 'pending' AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`,
      [req.user.organization_id]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const withLinks = invitations.map((inv) => ({
      ...inv,
      invite_link: `${frontendUrl}/register?invite=${inv.token}`,
    }));

    res.json({ invitations: withLinks });
  } catch (err) {
    console.error('List invitations error:', err);
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

router.post('/invitations', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { email, role = 'user' } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!ROLES.includes(role) || role === 'super_admin') {
      return res.status(400).json({ error: 'Invalid role for invitation' });
    }

    if (!canInviteRole(req.user.role, role)) {
      return res.status(403).json({ error: 'You cannot invite members with this role' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const [existingUser] = await pool.query(
      'SELECT id FROM users WHERE email = ? AND organization_id = ?',
      [normalizedEmail, req.user.organization_id]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'This person is already a team member' });
    }

    const [pending] = await pool.query(
      `SELECT id FROM invitations
       WHERE email = ? AND organization_id = ? AND status = 'pending' AND expires_at > NOW()`,
      [normalizedEmail, req.user.organization_id]
    );

    if (pending.length > 0) {
      return res.status(409).json({ error: 'An active invitation already exists for this email' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [result] = await pool.query(
      `INSERT INTO invitations (organization_id, email, role, token, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.organization_id, normalizedEmail, role, token, req.user.id, expiresAt]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteLink = `${frontendUrl}/register?invite=${token}`;

    const [orgs] = await pool.query(
      'SELECT name FROM organizations WHERE id = ?',
      [req.user.organization_id]
    );
    const organizationName = orgs[0]?.name || req.user.organization_name || 'your team';

    const emailResult = await sendInviteEmail({
      to: normalizedEmail,
      inviteLink,
      organizationName,
      roleLabel: ROLE_LABELS[role] || role,
      inviterName: req.user.name,
    });

    res.status(201).json({
      invitation: {
        id: result.insertId,
        email: normalizedEmail,
        role,
        token,
        expires_at: expiresAt,
        invite_link: inviteLink,
        email_sent: emailResult.sent,
        demo: emailResult.demo,
        email_message: emailResult.message,
      },
    });
  } catch (err) {
    console.error('Create invitation error:', err);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

router.delete('/invitations/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [result] = await pool.query(
      `UPDATE invitations SET status = 'cancelled'
       WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      [req.params.id, req.user.organization_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    res.json({ message: 'Invitation cancelled' });
  } catch (err) {
    console.error('Cancel invitation error:', err);
    res.status(500).json({ error: 'Failed to cancel invitation' });
  }
});

router.patch('/:id/role', requireRole('super_admin'), async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = parseInt(req.params.id, 10);

    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!canChangeMemberRole(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const [targets] = await pool.query(
      'SELECT id, role FROM users WHERE id = ? AND organization_id = ?',
      [targetId, req.user.organization_id]
    );

    if (targets.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const target = targets[0];

    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    if (target.role === 'super_admin' && role !== 'super_admin') {
      const [superAdmins] = await pool.query(
        `SELECT COUNT(*) AS count FROM users
         WHERE organization_id = ? AND role = 'super_admin'`,
        [req.user.organization_id]
      );

      if (superAdmins[0].count <= 1) {
        return res.status(400).json({ error: 'Organization must have at least one Super Admin' });
      }
    }

    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);

    const [updated] = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = ?',
      [targetId]
    );

    res.json({ member: updated[0] });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove yourself' });
    }

    const [targets] = await pool.query(
      'SELECT id, role FROM users WHERE id = ? AND organization_id = ?',
      [targetId, req.user.organization_id]
    );

    if (targets.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const target = targets[0];

    if (target.role === 'super_admin') {
      const [superAdmins] = await pool.query(
        `SELECT COUNT(*) AS count FROM users
         WHERE organization_id = ? AND role = 'super_admin'`,
        [req.user.organization_id]
      );

      if (superAdmins[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot remove the only Super Admin' });
      }
    }

    await pool.query('DELETE FROM users WHERE id = ?', [targetId]);

    res.json({ message: 'Member removed successfully' });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

export default router;
