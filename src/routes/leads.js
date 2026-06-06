import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const VALID_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM leads WHERE user_id = ?';
    const params = [req.user.id];

    if (status && VALID_STATUSES.includes(status)) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    query += ' ORDER BY created_at DESC';

    const [leads] = await pool.query(query, params);
    res.json({ leads });
  } catch (err) {
    console.error('Get leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT status, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY status`,
      [req.user.id]
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

router.get('/:id', async (req, res) => {
  try {
    const [leads] = await pool.query(
      'SELECT * FROM leads WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (leads.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ lead: leads[0] });
  } catch (err) {
    console.error('Get lead error:', err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, phone, source, status, notes } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const [result] = await pool.query(
      `INSERT INTO leads (user_id, name, email, phone, source, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name,
        email,
        phone || null,
        source || 'manual',
        status || 'new',
        notes || null,
      ]
    );

    const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    res.status(201).json({ lead: leads[0] });
  } catch (err) {
    console.error('Create lead error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, email, phone, source, status, notes } = req.body;

    const [existing] = await pool.query(
      'SELECT id FROM leads WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await pool.query(
      `UPDATE leads SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        source = COALESCE(?, source),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes)
       WHERE id = ? AND user_id = ?`,
      [name, email, phone, source, status, notes, req.params.id, req.user.id]
    );

    const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [req.params.id]);
    res.json({ lead: leads[0] });
  } catch (err) {
    console.error('Update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM leads WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ message: 'Lead deleted successfully' });
  } catch (err) {
    console.error('Delete lead error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

export default router;
