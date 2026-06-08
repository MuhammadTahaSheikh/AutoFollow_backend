import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  logActivity,
  getActivitiesForLead,
  getActivitiesForOrganization,
} from '../services/activity.js';
import { canAccessLead } from '../utils/leadAccess.js';
import pool from '../config/db.js';

const router = Router();
router.use(authenticate);

router.post('/', async (req, res) => {
  try {
    const { leadId, activityType, description, metadata } = req.body;

    if (!activityType || !description) {
      return res.status(400).json({ error: 'activityType and description are required' });
    }

    if (leadId) {
      const lead = await canAccessLead(pool, req.user, leadId);
      if (!lead) {
        return res.status(404).json({ error: 'Lead not found' });
      }
    }

    const activity = await logActivity(pool, {
      organizationId: req.user.organization_id,
      leadId: leadId || null,
      userId: req.user.id,
      activityType,
      description,
      metadata: metadata || null,
    });

    res.status(201).json({ activity });
  } catch (err) {
    console.error('Create activity error:', err);
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

router.get('/lead/:leadId', async (req, res) => {
  try {
    const activities = await getActivitiesForLead(req.user, req.params.leadId);
    res.json({ activities });
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('Get lead activities error:', err);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/organization', async (req, res) => {
  try {
    const activities = await getActivitiesForOrganization(req.user);
    res.json({ activities });
  } catch (err) {
    console.error('Get org activities error:', err);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

export default router;
