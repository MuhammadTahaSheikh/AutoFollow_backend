import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const PROFILE_FIELDS = [
  'company_name',
  'job_title',
  'phone',
  'calendar_url',
  'services_description',
];

router.get('/', async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, name, email, company_name, job_title, phone, calendar_url, services_description
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ profile: users[0] });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { company_name, job_title, phone, calendar_url, services_description } = req.body;

    await pool.query(
      `UPDATE users SET
        company_name = ?,
        job_title = ?,
        phone = ?,
        calendar_url = ?,
        services_description = ?
       WHERE id = ?`,
      [
        company_name || null,
        job_title || null,
        phone || null,
        calendar_url || null,
        services_description || null,
        req.user.id,
      ]
    );

    const [users] = await pool.query(
      `SELECT id, name, email, company_name, job_title, phone, calendar_url, services_description
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    res.json({ profile: users[0] });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
