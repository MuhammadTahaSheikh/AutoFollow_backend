import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  scheduleEmail,
  sendEmailNow,
  getEmailSchedules,
  cancelEmail,
} from '../services/email.js';

const router = Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const leadId = req.query.leadId ? parseInt(req.query.leadId, 10) : null;
    const schedules = await getEmailSchedules(req.user.id, leadId);
    res.json({ schedules });
  } catch (err) {
    console.error('Get emails error:', err);
    res.status(500).json({ error: 'Failed to fetch email schedules' });
  }
});

router.post('/schedule', async (req, res) => {
  try {
    const { leadId, subject, body, scheduledAt, delayHours } = req.body;

    if (!leadId || !subject || !body) {
      return res.status(400).json({ error: 'leadId, subject, and body are required' });
    }

    let scheduled = scheduledAt;
    if (!scheduled && delayHours) {
      scheduled = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();
    }

    if (!scheduled) {
      return res.status(400).json({ error: 'scheduledAt or delayHours is required' });
    }

    const schedule = await scheduleEmail(req.user.id, {
      leadId,
      subject,
      body,
      scheduledAt: new Date(scheduled),
    });

    res.status(201).json({ schedule });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Schedule email error:', err);
    res.status(500).json({ error: 'Failed to schedule email' });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { leadId, subject, body } = req.body;

    if (!leadId || !subject || !body) {
      return res.status(400).json({ error: 'leadId, subject, and body are required' });
    }

    const result = await sendEmailNow(req.user.id, { leadId, subject, body });
    res.json({ schedule: result });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Send email error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const schedule = await cancelEmail(req.user.id, req.params.id);
    res.json({ schedule });
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    console.error('Cancel email error:', err);
    res.status(500).json({ error: 'Failed to cancel email' });
  }
});

export default router;
