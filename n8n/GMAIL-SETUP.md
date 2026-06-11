# Gmail send + reply capture setup

Use **muhammadtahakamran19@gmail.com** for AI follow-up outbound emails and capture lead replies in the CRM.

## 1. Google account (one-time)

### Step A — Enable 2-Step Verification (required first)

App Passwords are **hidden** until 2-Step Verification is on.

1. Open [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification)
2. Click **Get started** and finish setup (phone SMS or authenticator app)
3. Wait a few minutes, then open [App Passwords](https://myaccount.google.com/apppasswords) again

If you still see *"The setting that you are looking for is not available for your account"*:

- The account may be **Google Workspace** — your admin must allow App Passwords
- Or the account is **supervised / under 18** — App Passwords may be blocked
- Use **n8n Gmail OAuth** node for inbox (see section 3b) as an alternative for replies only

### Step B — Create App Password

1. [App Passwords](https://myaccount.google.com/apppasswords) → App: **Mail**, Device: **Other** → name it `AutoFollow`
2. Copy the **16-character password** (e.g. `abcd efgh ijkl mnop`) into `GMAIL_APP_PASSWORD` in `.env` (spaces optional)

### Step C — Enable IMAP

Gmail → **Settings → See all settings → Forwarding and POP/IMAP** → enable **IMAP**.

## 2. Backend `.env` (VPS)

```env
EMAIL_PROVIDER=gmail
GMAIL_USER=muhammadtahakamran19@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
EMAIL_FROM=muhammadtahakamran19@gmail.com
EMAIL_FROM_NAME=bestechVison
INVITE_REPLY_TO=muhammadtahakamran19@gmail.com

N8N_WEBHOOK_SECRET=your-existing-secret
```

Restart the API after saving:

```bash
pm2 restart autofollow-api
```

## 3. n8n workflow

1. Import or update from `autofollow-email-reply.workflow.json`.
2. **Poll Gmail Inbox** — create IMAP credentials:
   - Host: `imap.gmail.com`
   - Port: `993`
   - SSL/TLS: on
   - User: `muhammadtahakamran19@gmail.com`
   - Password: **App Password** (16 characters, no spaces)
3. **Send to CRM Webhook** — set `x-webhook-secret` to match `N8N_WEBHOOK_SECRET` in backend `.env`.
4. Activate the workflow.

### 3b. Alternative: n8n Gmail node (OAuth — no App Password for inbox)

If App Passwords stay unavailable, use n8n’s **Gmail Trigger** or **Gmail** node with **OAuth2** credentials instead of IMAP. Connect `muhammadtahakamran19@gmail.com` in n8n, then map the same fields into **Prepare CRM Payload** → webhook.

Outbound send from the CRM still needs either an App Password or OAuth in the backend.

## 4. How it works

| Step | What happens |
|------|----------------|
| AI Follow-up → Send | CRM sends via Gmail SMTP from `muhammadtahakamran19@gmail.com` |
| Lead replies | Reply lands in the same Gmail inbox |
| n8n polls INBOX | Filters out your own address, posts to `/api/webhooks/n8n/email-reply` |
| CRM | Matches lead by reply `from` email, shows thread under **Emails → Conversations** |

## 5. Why emails land in spam (and how to fix)

| Cause | Fix |
|-------|-----|
| Sender name was **AutoFollow** / **noreply@** (looks automated) | Now uses your real name + Gmail address |
| **AI sales language** + many follow-ups quickly | Send fewer test emails; personalize in Settings → Profile |
| Old **Resend / noreply@bestechvision.com** emails | Disable Resend in `.env`; only use Gmail |
| Gmail App Password **not quoted** in `.env` | Use `GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"` |
| Recipient marks similar mail as spam once | Ask them to click **Not spam** and add you to contacts |

**Mark as Not spam** in Gmail for the first few messages — this trains Gmail that your emails are wanted.

## 6. Why copies still go to info@bestechvision.com

This happens when **old settings** are still active somewhere:

1. **Production VPS `.env`** still has `INVITE_REPLY_TO=info@bestechvision.com` → update to your Gmail and restart PM2
2. **n8n still polls Hostinger** (`info@bestechvision.com` inbox) instead of Gmail
3. **Old emails in the thread** had Reply-To `info@` — new sends use Gmail only after restart

Update VPS `.env` to match local Gmail settings, then: `pm2 restart autofollow-api`

## 7. Test

1. Send a test AI email to a lead whose email is in your CRM.
2. Reply from that lead’s inbox.
3. Within ~1–2 minutes (n8n poll interval), check **Emails → Conversations** in the dashboard.
