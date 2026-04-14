// MAWD Scheduled Letters API + Cron Dispatcher
// GET    /api/scheduled                       -> list scheduled/sent letters
// POST   /api/scheduled                       -> { title, subject, body, listenUrl, duration, scheduledFor }
// DELETE /api/scheduled?id=UUID               -> cancel a scheduled letter
// GET    /api/scheduled?dispatch=1            -> (cron) send any due letters
//
// The dispatcher is called by Vercel Cron on a schedule (see vercel.json).
// Vercel Cron requests include the CRON_SECRET in the Authorization header.

import { sendEmail } from '../lib/google.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const DELAY_MS = 500;

async function sb(path, options) {
  options = options || {};
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()));
  if (options.method === 'DELETE') return { ok: true };
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getFanContacts() {
  const url = SUPABASE_URL + '/rest/v1/fan_contacts?do_not_email=eq.false&email=not.is.null&select=email,name,fan_score&order=fan_score.desc.nullslast';
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error('fan_contacts: ' + await res.text());
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildHtml(plainBody, fanName, letter) {
  const body = (plainBody || '')
    .replace(/\{\{name\}\}/g, fanName || 'there')
    .replace(/\n/g, '<br>');
  const link = letter.listen_url || 'https://app.fanded.com/club/travisatreo';
  const title = letter.title || letter.subject;
  const dur = letter.duration || '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#09090B;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#09090B;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">
<tr><td style="padding-bottom:32px;color:#fff;font-size:16px;line-height:1.6;">${body}</td></tr>
<tr><td align="center" style="padding:16px 0 24px;"><a href="${link}" style="display:inline-block;padding:14px 28px;background:#D4AF37;color:#09090B;text-decoration:none;border-radius:10px;font-weight:600;">Listen: ${title}${dur ? ' (' + dur + ')' : ''}</a></td></tr>
<tr><td style="padding-top:24px;color:#71717A;font-size:12px;text-align:center;">Travis Atreo · <a href="${link}" style="color:#71717A;">fanded.com</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function dispatchDueLetters() {
  const nowIso = new Date().toISOString();
  const due = await sb('mawd_scheduled_letters?status=eq.scheduled&scheduled_for=lte.' + encodeURIComponent(nowIso) + '&order=scheduled_for.asc&limit=5');
  const summary = { processed: 0, sent: 0, failed: 0, letters: [] };
  for (const letter of due) {
    // Mark in-flight to avoid double-send if overlapping crons
    await sb('mawd_scheduled_letters?id=eq.' + letter.id, {
      method: 'PATCH',
      body: { status: 'sending' }
    });
    try {
      const fans = await getFanContacts();
      let sent = 0, failed = 0;
      const errors = [];
      for (const fan of fans) {
        try {
          await sendEmail({
            to: fan.email,
            subject: letter.subject,
            body: (letter.body || '').replace(/\{\{name\}\}/g, fan.name || 'there'),
            html: buildHtml(letter.body, fan.name, letter)
          });
          sent++;
        } catch (e) {
          failed++;
          if (errors.length < 5) errors.push(fan.email + ': ' + (e.message || '').substring(0, 80));
        }
        if (fans.length > 1) await sleep(DELAY_MS);
      }
      await sb('mawd_scheduled_letters?id=eq.' + letter.id, {
        method: 'PATCH',
        body: {
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_count: sent,
          failed_count: failed,
          last_error: errors.length ? errors.join('; ') : null
        }
      });
      summary.sent += sent;
      summary.failed += failed;
      summary.processed++;
      summary.letters.push({ id: letter.id, title: letter.title, sent, failed });
    } catch (err) {
      await sb('mawd_scheduled_letters?id=eq.' + letter.id, {
        method: 'PATCH',
        body: { status: 'failed', last_error: (err.message || '').substring(0, 500) }
      });
      summary.letters.push({ id: letter.id, title: letter.title, error: err.message });
    }
  }
  return summary;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const isDispatch = req.query && req.query.dispatch === '1';
    const id = req.query && req.query.id ? req.query.id : null;

    // Cron dispatch path
    if (isDispatch) {
      // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
      const auth = req.headers.authorization || '';
      if (CRON_SECRET && auth !== 'Bearer ' + CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const summary = await dispatchDueLetters();
      return res.status(200).json(summary);
    }

    if (req.method === 'GET') {
      const rows = await sb('mawd_scheduled_letters?select=id,title,subject,scheduled_for,status,sent_at,sent_count,failed_count,last_error&order=scheduled_for.desc&limit=100');
      return res.status(200).json({ letters: rows });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
      const { title, subject, body: letterBody, listenUrl, duration, scheduledFor } = body;
      if (!subject || !letterBody || !scheduledFor) {
        return res.status(400).json({ error: 'subject, body, scheduledFor required' });
      }
      if (new Date(scheduledFor) <= new Date()) {
        return res.status(400).json({ error: 'scheduledFor must be in the future' });
      }
      const created = await sb('mawd_scheduled_letters', {
        method: 'POST',
        body: {
          title: title || null,
          subject,
          body: letterBody,
          listen_url: listenUrl || null,
          duration: duration || null,
          scheduled_for: new Date(scheduledFor).toISOString()
        }
      });
      return res.status(201).json(Array.isArray(created) ? created[0] : created);
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb('mawd_scheduled_letters?id=eq.' + id, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Scheduled letters error:', err);
    return res.status(500).json({ error: err.message });
  }
}
