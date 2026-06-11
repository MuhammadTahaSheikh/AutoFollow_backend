import cron from 'node-cron';
import { processPendingEmails, recoverStuckSendingEmails } from '../services/email.js';

export function startEmailScheduler() {
  recoverStuckSendingEmails()
    .then(() => processPendingEmails())
    .catch((err) => {
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
