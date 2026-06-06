import cron from 'node-cron';
import { processPendingEmails } from '../services/email.js';

export function startEmailScheduler() {
  // Run once on startup to catch emails missed while server was down
  processPendingEmails().catch((err) => {
    console.error('Email scheduler startup error:', err);
  });

  cron.schedule('* * * * *', async () => {
    try {
      await processPendingEmails();
    } catch (err) {
      console.error('Email scheduler error:', err);
    }
  });

  console.log('Email scheduler started (runs every minute)');
}
