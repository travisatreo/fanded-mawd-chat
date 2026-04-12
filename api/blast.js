// MAWD Email Blast API
// Sends bulk emails to fan_contacts via Gmail API
// POST /api/blast { subject, body, testOnly?, limit? }

import { sendEmail } from './google.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Rate limit: Gmail allows ~2000/day, ~100/second burst
// We send one at a time with a small delay to be safe
const DELAY_MS = 500;

async function getFanContacts({ limit, testOnly }) {
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');

  // If test mode, only get Travis's own email
  if (testOnly) {
    return [{ email: 'travis@travisatreo.com', name: 'Travis Atreo' }];
  }

  let url = `${SUPABASE_URL}/rest/v1/fan_contacts?do_not_email=eq.false&email=not.is.null&select=email,name,fan_score&order=fan_score.desc.nullslast`;
  if (limit) url += `&limit=${limit}`;

  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });

  if (!res.ok) throw new Error('Supabase query failed: ' + await res.text());
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Simple auth check
  const auth = req.headers.authorization;
  const expectedKey = process.env.BLAST_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!auth || !auth.includes(expectedKey?.substring(0, 20))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { subject, body, testOnly, limit } = req.body || {};

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }

  try {
    const fans = await getFanContacts({ limit, testOnly });
    const results = { sent: 0, failed: 0, errors: [], total: fans.length };

    for (const fan of fans) {
      try {
        await sendEmail({
          to: fan.email,
          subject,
          body: body.replace('{{name}}', fan.name || 'there')
        });
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push({ email: fan.email, error: err.message?.substring(0, 100) });
      }

      // Rate limiting
      if (fans.length > 1) await sleep(DELAY_MS);
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
