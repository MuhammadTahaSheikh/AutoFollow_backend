import { Router } from 'express';
import { recordInboundReply } from '../services/emailReplies.js';

const router = Router();

function verifyWebhookSecret(req, res, next) {
  const secret = process.env.N8N_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return res.status(503).json({
      error: 'Webhook not configured. Set N8N_WEBHOOK_SECRET in backend/.env',
    });
  }

  const header = req.headers['x-webhook-secret'];
  if (!header || header !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  next();
}

router.post('/n8n/email-reply', verifyWebhookSecret, async (req, res) => {
  try {
    const result = await recordInboundReply(req.body);

    if (result.duplicate) {
      return res.status(200).json({
        message: 'Already processed',
        reply: result.reply,
      });
    }

    res.status(201).json({
      message: 'Reply recorded',
      reply: result.reply,
      lead: { id: result.lead.id, name: result.lead.name, email: result.lead.email },
    });
  } catch (err) {
    if (err.code === 'LEAD_NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    if (err.message === 'from_email is required') {
      return res.status(400).json({ error: err.message });
    }
    console.error('n8n email-reply webhook error:', err);
    res.status(500).json({ error: 'Failed to record reply' });
  }
});

export default router;
