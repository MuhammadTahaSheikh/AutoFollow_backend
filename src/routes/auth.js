import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { formatUserResponse, loadUserAccount } from '../utils/orgAccess.js';

const router = Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, organization_id: user.organization_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

async function acceptInvitation(connection, invite, { name, email, passwordHash }) {
  const [result] = await connection.query(
    `INSERT INTO users (name, email, password_hash, role, organization_id)
     VALUES (?, ?, ?, ?, ?)`,
    [name, email, passwordHash, invite.role, invite.organization_id]
  );

  await connection.query(
    `UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = ?`,
    [invite.id]
  );

  return result.insertId;
}

router.get('/invite/:token', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.email, i.role, i.status, i.expires_at, o.name AS organization_name
       FROM invitations i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.token = ?`,
      [req.params.token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invite = rows[0];

    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'This invitation is no longer valid' });
    }

    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This invitation has expired' });
    }

    res.json({
      invitation: {
        email: invite.email,
        role: invite.role,
        organization_name: invite.organization_name,
      },
    });
  } catch (err) {
    console.error('Verify invite error:', err);
    res.status(500).json({ error: 'Failed to verify invitation' });
  }
});

router.post('/register', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { name, email, password, inviteToken, organizationName } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await connection.beginTransaction();

    let userId;
    let role = 'super_admin';
    let organizationId;

    if (inviteToken) {
      const [invites] = await connection.query(
        `SELECT * FROM invitations
         WHERE token = ? AND status = 'pending' AND expires_at > NOW()`,
        [inviteToken]
      );

      if (invites.length === 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Invalid or expired invitation' });
      }

      const invite = invites[0];

      if (invite.email.toLowerCase() !== normalizedEmail) {
        await connection.rollback();
        return res.status(400).json({ error: 'Email must match the invitation' });
      }

      userId = await acceptInvitation(connection, invite, {
        name,
        email: normalizedEmail,
        passwordHash,
      });
      role = invite.role;
      organizationId = invite.organization_id;
    } else {
      const orgName = (organizationName || `${name}'s Organization`).trim().slice(0, 255);

      const [orgResult] = await connection.query(
        'INSERT INTO organizations (name) VALUES (?)',
        [orgName]
      );
      organizationId = orgResult.insertId;

      const [result] = await connection.query(
        `INSERT INTO users (name, email, password_hash, role, organization_id)
         VALUES (?, ?, ?, 'super_admin', ?)`,
        [name, normalizedEmail, passwordHash, organizationId]
      );
      userId = result.insertId;
    }

    await connection.commit();

    const user = await loadUserAccount(userId);
    const token = signToken(user);

    res.status(201).json({
      token,
      user: formatUserResponse(user),
    });
  } catch (err) {
    await connection.rollback();
    console.error('Register error:', err);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'Registration failed';
    res.status(500).json({ error: message });
  } finally {
    connection.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [users] = await pool.query(
      'SELECT id, name, email, password_hash, role, organization_id FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const fullUser = await loadUserAccount(user.id);
    const token = signToken(fullUser);

    res.json({
      token,
      user: formatUserResponse(fullUser),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({ user: formatUserResponse(req.user) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
