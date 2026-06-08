import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import leadsRoutes from './routes/leads.js';
import aiRoutes from './routes/ai.js';
import emailsRoutes from './routes/emails.js';
import profileRoutes from './routes/profile.js';
import membersRoutes from './routes/members.js';
import activitiesRoutes from './routes/activities.js';
import notesRoutes from './routes/notes.js';
import sequencesRoutes from './routes/sequences.js';
import webhooksRoutes from './routes/webhooks.js';
import { startEmailScheduler } from './jobs/emailScheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'AutoFollow AI CRM API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/emails', emailsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/sequences', sequencesRoutes);
app.use('/api/webhooks', webhooksRoutes);

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AutoFollow API running on http://localhost:${PORT}`);
  startEmailScheduler();
});
