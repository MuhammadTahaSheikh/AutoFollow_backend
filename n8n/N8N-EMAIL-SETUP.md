# n8n email setup (send + receive)

Run **all** lead emails through n8n and your Gmail account `muhammadtahakamran19@gmail.com`.

| Direction | n8n workflow | CRM endpoint |
|-----------|--------------|--------------|
| **Send** (AI follow-up) | `autofollow-send-email.workflow.json` | CRM → n8n webhook |
| **Receive** (lead replies) | `autofollow-email-reply.workflow.json` | n8n → CRM webhook |

No Google App Password needed for sending — use **Gmail OAuth** in n8n.

---

## 1. Generate webhook secret

```bash
openssl rand -hex 32
```

Use the same value in **backend `.env`** and **both n8n workflows**.

---

## 2. Backend `.env`

```env
EMAIL_PROVIDER=n8n
GMAIL_USER=muhammadtahakamran19@gmail.com
EMAIL_FROM=muhammadtahakamran19@gmail.com
EMAIL_FROM_NAME=bestechVison
INVITE_REPLY_TO=muhammadtahakamran19@gmail.com

N8N_WEBHOOK_SECRET=your-secret-here
N8N_SEND_WEBHOOK_URL=https://YOUR-N8N-URL/webhook/send-lead-email
```

Restart API after saving.

---

## 3. Import n8n workflows

### A) Send emails — `autofollow-send-email.workflow.json`

1. Import workflow in n8n
2. **CRM Send Request** — note the Production URL (e.g. `https://n8n.example.com/webhook/send-lead-email`)
3. **Verify Webhook Secret** — paste your `N8N_WEBHOOK_SECRET`
4. **Send via Gmail** — connect Gmail OAuth for `muhammadtahakamran19@gmail.com`
5. Activate workflow
6. Put the Production URL in `N8N_SEND_WEBHOOK_URL`

### B) Capture replies — `autofollow-email-reply.workflow.json`

1. Import workflow
2. **Poll Gmail Inbox** — Gmail OAuth (same account) or IMAP + App Password
3. **Send to CRM Webhook** — URL: `http://187.124.52.234/api/webhooks/n8n/email-reply` (n8n runs in Docker — do **not** use `127.0.0.1:5000`)
4. Header `x-webhook-secret`: same secret as backend
5. Activate workflow

---

## 4. Flow

```
User clicks Send in CRM
    → Backend POSTs to n8n /webhook/send-lead-email
    → n8n sends via Gmail OAuth
    → Lead receives email from muhammadtahakamran19@gmail.com

Lead replies
    → Lands in Gmail inbox
    → n8n polls inbox
    → n8n POSTs to CRM /api/webhooks/n8n/email-reply
    → Reply shows under Emails → Conversations
```

---

## 5. Test

1. Restart backend — log should show: `Email provider: n8n → https://...`
2. Send AI follow-up to a test lead
3. Check n8n execution history (should be green)
4. Reply from lead email
5. Check CRM **Emails → Conversations**

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `n8n send failed` | Workflow not active; wrong `N8N_SEND_WEBHOOK_URL`; secret mismatch |
| Replies stop at Filter node | Old Filter node checked full email body (includes your address in quotes). Use Code filter from `autofollow-email-reply.workflow.json` |
| CRM webhook 401 | `x-webhook-secret` in n8n must match `N8N_WEBHOOK_SECRET` in backend `.env` — not the placeholder |
| `service refused the connection` on webhook | n8n is in Docker — use `http://187.124.52.234/api/...` not `127.0.0.1:5000` |
| Only 2 nodes run then stop | Filter discarded the email — reconnect Gmail OAuth; mark reply **Unread** in Gmail; wait 1–2 min |
| Two emails sent | Restart backend (duplicate-send fix requires `sending` status in DB — run `npm run db:init`) |
| Replies not in CRM | Activate reply workflow; verify CRM webhook URL and secret |
| Gmail OAuth in n8n | Google Cloud → OAuth consent → add Gmail send + read scopes |
