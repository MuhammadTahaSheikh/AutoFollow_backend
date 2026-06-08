import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getSequences,
  getSequence,
  createSequence,
  updateSequence,
  deleteSequence,
} from '../services/sequences.js';

const router = Router();
router.use(authenticate);
router.use(requireRole('super_admin', 'admin'));

router.get('/', async (req, res) => {
  try {
    const sequences = await getSequences(req.user);
    res.json({ sequences });
  } catch (err) {
    console.error('Get sequences error:', err);
    res.status(500).json({ error: 'Failed to fetch sequences' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, is_active, steps } = req.body;
    const sequence = await createSequence(req.user, { name, is_active, steps });
    res.status(201).json({ sequence });
  } catch (err) {
    if (err.message.includes('required')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Create sequence error:', err);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const sequence = await updateSequence(req.user, req.params.id, req.body);
    res.json({ sequence });
  } catch (err) {
    if (err.message === 'Sequence not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Update sequence error:', err);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteSequence(req.user, req.params.id);
    res.json(result);
  } catch (err) {
    if (err.message === 'Sequence not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Delete sequence error:', err);
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

export default router;
