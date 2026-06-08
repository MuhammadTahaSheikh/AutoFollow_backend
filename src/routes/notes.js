import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  createNote,
  getNotesForLead,
  updateNote,
  deleteNote,
} from '../services/notes.js';

const router = Router();
router.use(authenticate);

router.post('/', async (req, res) => {
  try {
    const { leadId, note } = req.body;

    if (!leadId || !note?.trim()) {
      return res.status(400).json({ error: 'leadId and note are required' });
    }

    const created = await createNote(req.user, { leadId, note: note.trim() });
    res.status(201).json({ note: created });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Create note error:', err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

router.get('/lead/:leadId', async (req, res) => {
  try {
    const notes = await getNotesForLead(req.user, req.params.leadId);
    res.json({ notes });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Get notes error:', err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { note } = req.body;

    if (!note?.trim()) {
      return res.status(400).json({ error: 'note is required' });
    }

    const updated = await updateNote(req.user, req.params.id, note.trim());
    res.json({ note: updated });
  } catch (err) {
    if (err.message === 'Note not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('only edit')) {
      return res.status(403).json({ error: err.message });
    }
    console.error('Update note error:', err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteNote(req.user, req.params.id);
    res.json(result);
  } catch (err) {
    if (err.message === 'Note not found') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message.includes('only delete')) {
      return res.status(403).json({ error: err.message });
    }
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

export default router;
