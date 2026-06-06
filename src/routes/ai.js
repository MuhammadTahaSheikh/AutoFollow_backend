import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { generateMessage, getTemplates } from '../services/ai.js';

const router = Router();
router.use(authenticate);

const VALID_TYPES = ['follow_up', 'sales', 're_engagement'];

router.post('/generate', async (req, res) => {
  try {
    const { leadId, type, customInstructions } = req.body;

    if (!leadId || !type) {
      return res.status(400).json({ error: 'leadId and type are required' });
    }

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Use: follow_up, sales, re_engagement' });
    }

    const result = await generateMessage(req.user, leadId, type, customInstructions);
    res.json(result);
  } catch (err) {
    if (err.message === 'Lead not found') {
      return res.status(404).json({ error: err.message });
    }
    console.error('AI generate error:', err);
    const message =
      process.env.NODE_ENV === 'development' && err?.code === 'invalid_api_key'
        ? 'Invalid OpenAI API key. Add OPENAI_API_KEY to backend/.env'
        : 'Failed to generate message';
    res.status(500).json({ error: message });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const leadId = req.query.leadId ? parseInt(req.query.leadId, 10) : null;
    const templates = await getTemplates(req.user, leadId);
    res.json({ templates });
  } catch (err) {
    console.error('Get templates error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

export default router;
