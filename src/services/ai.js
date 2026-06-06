import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from '../config/db.js';
import { canAccessLead, leadListFilter } from '../utils/leadAccess.js';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
].filter((m, i, arr) => arr.indexOf(m) === i);

const SYSTEM_PROMPT = `You are a professional sales and follow-up email writer for AutoFollow AI CRM.
Write personalized, concise emails that feel human and warm — not robotic or overly salesy.
Use the sender's real business details provided in the prompt. NEVER use bracket placeholders like [Your Name], [Company], [Link], or similar — always use the actual values given.
If a detail is missing, omit that sentence rather than inventing a placeholder.
Keep emails under 200 words unless asked otherwise.
Do not include a subject line unless specifically requested — output only the email body.`;

function buildSenderContext(profile) {
  const lines = [
    `Sender name: ${profile.name}`,
    profile.job_title ? `Sender title: ${profile.job_title}` : null,
    profile.company_name ? `Company: ${profile.company_name}` : null,
    profile.phone ? `Phone: ${profile.phone}` : null,
    profile.calendar_url ? `Calendar booking link: ${profile.calendar_url}` : null,
    profile.services_description
      ? `What we offer: ${profile.services_description}`
      : null,
    `Sender email: ${profile.email}`,
  ].filter(Boolean);

  return lines.join('\n');
}

function buildPrompt(type, lead, profile, customInstructions) {
  const senderBlock = buildSenderContext(profile);
  const company = profile.company_name || 'our team';
  const services = profile.services_description || 'solutions tailored to your needs';

  const typeInstructions = {
    follow_up: `Write a friendly follow-up email checking in after initial contact. Mention ${company} and how ${services} could help ${lead.name}.`,
    sales: `Write a persuasive but not pushy sales email highlighting value. Reference ${company} and ${services} specifically for ${lead.name}.`,
    re_engagement: `Write a re-engagement email for a lead who has gone quiet. Be warm and offer a low-pressure way to reconnect via ${company}.`,
  };

  let prompt = `${typeInstructions[type] || typeInstructions.follow_up}

Sender (use these exact details in the email signature and body — no placeholders):
${senderBlock}

Lead details:
- Name: ${lead.name}
- Email: ${lead.email}
${lead.notes ? `- Notes: ${lead.notes}` : ''}
${lead.source ? `- Source: ${lead.source}` : ''}`;

  if (customInstructions?.trim()) {
    prompt += `\n\nAdditional instructions from the sender (follow these closely):\n${customInstructions.trim()}`;
  }

  return prompt;
}

function buildDemoMessage(type, lead, profile) {
  const name = profile.name || 'Your Team';
  const title = profile.job_title || '';
  const company = profile.company_name || 'AutoFollow AI CRM';
  const phone = profile.phone || '';
  const calendar = profile.calendar_url || '';
  const services = profile.services_description || 'streamline your follow-ups and boost sales with AI-powered outreach';

  const contactLines = [
    calendar ? `You can book a time on my calendar here: ${calendar}` : null,
    phone ? `Or feel free to call me at ${phone}.` : null,
  ].filter(Boolean);

  const contactBlock = contactLines.length
    ? `\n\n${contactLines.join(' ')}\n`
    : '\n\n';

  const signature = [name, title, company].filter(Boolean).join('\n');

  const templates = {
    follow_up: `[Demo] Hi ${lead.name},

It was great connecting recently. I wanted to follow up and see if you've had a chance to consider how ${company} could help you ${services}.

We're confident we can offer something tailored to your needs.${contactBlock}
Looking forward to hearing from you!

Best regards,
${signature}`,

    sales: `[Demo] Hi ${lead.name},

I hope this message finds you well. At ${company}, we help businesses like yours ${services}.

I'd love to show you how we can deliver real results for your team.${contactBlock}
Would you be open to a quick conversation this week?

Best,
${signature}`,

    re_engagement: `[Demo] Hi ${lead.name},

It's been a while since we last connected, and I wanted to reach out from ${company}.

If timing is better now, we'd love to help you ${services}.${contactBlock}
No pressure — just let me know if you'd like to chat.

Warm regards,
${signature}`,
  };

  return templates[type] || templates.follow_up;
}

async function saveDemoMessage(userId, leadId, type, content) {
  await pool.query(
    'INSERT INTO ai_templates (user_id, lead_id, type, content) VALUES (?, ?, ?, ?)',
    [userId, leadId, type, content]
  );
  return { content, demo: true };
}

async function fetchUserProfile(userId) {
  const [users] = await pool.query(
    `SELECT name, email, company_name, job_title, phone, calendar_url, services_description
     FROM users WHERE id = ?`,
    [userId]
  );
  return users[0] || { name: 'User', email: '' };
}

async function generateWithGemini(prompt) {
  let lastError;

  for (const modelName of GEMINI_FALLBACK_MODELS) {
    try {
      const model = gemini.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();

      if (text?.trim()) {
        return text.trim();
      }
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      const retryable =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('overloaded');

      if (retryable) {
        console.warn(`Gemini model ${modelName} unavailable, trying next...`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

export async function generateMessage(user, leadId, type, customInstructions = '') {
  const lead = await canAccessLead(pool, user, leadId);

  if (!lead) {
    throw new Error('Lead not found');
  }

  const profile = await fetchUserProfile(user.id);
  const prompt = buildPrompt(type, lead, profile, customInstructions);

  const useGemini = AI_PROVIDER === 'gemini' && gemini;
  const useOpenAI = AI_PROVIDER !== 'gemini' && openai;

  if (!useGemini && !useOpenAI) {
    const demo = buildDemoMessage(type, lead, profile);
    return saveDemoMessage(user.id, leadId, type, demo);
  }

  try {
    let content;

    if (useGemini) {
      content = await generateWithGemini(prompt);
    } else {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.7,
      });
      content = completion.choices[0]?.message?.content?.trim();
    }

    if (!content) {
      throw new Error('Empty AI response');
    }

    await pool.query(
      'INSERT INTO ai_templates (user_id, lead_id, type, content) VALUES (?, ?, ?, ?)',
      [user.id, leadId, type, content]
    );

    return { content, demo: false };
  } catch (err) {
    console.error('AI generation error:', err.message);
    const demo = buildDemoMessage(type, lead, profile);
    return saveDemoMessage(user.id, leadId, type, demo);
  }
}

export async function getTemplates(user, leadId) {
  const filter = leadListFilter(user, 'l');

  if (leadId) {
    const [templates] = await pool.query(
      `SELECT at.* FROM ai_templates at
       JOIN leads l ON at.lead_id = l.id
       WHERE ${filter.where} AND at.lead_id = ?
       ORDER BY at.created_at DESC`,
      [...filter.params, leadId]
    );
    return templates;
  }

  const [templates] = await pool.query(
    `SELECT at.* FROM ai_templates at
     JOIN leads l ON at.lead_id = l.id
     WHERE ${filter.where}
     ORDER BY at.created_at DESC`,
    filter.params
  );
  return templates;
}
