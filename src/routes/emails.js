import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  scheduleEmail,
  sendEmailNow,
  getEmailSchedules,
  cancelEmail,
} from '../services/email.js';
import { getEmailReplies, getAllEmailReplies } from '../services/emailReplies.js';
import { assertWithinLimit, handleUsageLimitError } from '../services/usage.js';

const router = Router();
router.use(authenticate);

router.get('/replies', async (req, res) => {
  try {
    const leadId = req.query.leadId ? parseInt(req.query.leadId, 10) : null;
    const replies = leadId
      ? await getEmailReplies(req.user, leadId)
      : await getAllEmailReplies(req.user);
    res.json({ replies });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Get email replies error:', err);
    res.status(500).json({ error: 'Failed to fetch email replies' });
  }
});

router.get('/', async (req, res) => {
  try {
    const leadId = req.query.leadId ? parseInt(req.query.leadId, 10) : null;
    const schedules = await getEmailSchedules(req.user, leadId);
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

    if (req.user.organization_id) {
      await assertWithinLimit(req.user.organization_id, 'emails');
    }

    const schedule = await scheduleEmail(req.user, {
      leadId,
      subject,
      body,
      scheduledAt: new Date(scheduled),
    });

    res.status(201).json({ schedule });
  } catch (err) {
    if (handleUsageLimitError(err, res)) return;
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

    if (req.user.organization_id) {
      await assertWithinLimit(req.user.organization_id, 'emails');
    }

    const result = await sendEmailNow(req.user, { leadId, subject, body });
    res.json({ schedule: result });
  } catch (err) {
    if (handleUsageLimitError(err, res)) return;
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Send email error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const schedule = await cancelEmail(req.user, req.params.id);
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
