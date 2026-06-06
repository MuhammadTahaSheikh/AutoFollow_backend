import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import leadsRoutes from './routes/leads.js';
import aiRoutes from './routes/ai.js';
import emailsRoutes from './routes/emails.js';
import profileRoutes from './routes/profile.js';
import { startEmailScheduler } from './jobs/emailScheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`AutoFollow API running on http://localhost:${PORT}`);
  startEmailScheduler();
});
