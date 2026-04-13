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

  const { subject, body, testOnly, limit, listenUrl, title, duration } = req.body || {};

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }

  // Build HTML email template
  function buildHtmlEmail(plainBody, fanName) {
    const personalizedBody = plainBody
      .replace(/\{\{name\}\}/g, fanName || 'there')
      .replace(/\n/g, '<br>');

    const link = listenUrl || 'https://app.fanded.com/club/travisatreo';
    const letterTitle = title || subject;
    const dur = duration || '';

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#09090B;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#09090B;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">

<!-- Header -->
<tr><td style="text-align:center;padding-bottom:32px;">
  <span style="color:#C4953A;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;">A letter from Travis</span>
</td></tr>

<!-- Body text -->
<tr><td style="color:#E4E4E7;font-size:16px;line-height:1.7;padding-bottom:28px;">
  ${personalizedBody}
</td></tr>

<!-- Audio card -->
<tr><td style="padding-bottom:32px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#18181B;border:1px solid #27272A;border-radius:16px;">
  <tr><td style="padding:24px;text-align:center;">
    <div style="font-size:15px;font-weight:600;color:#FAFAFA;margin-bottom:4px;">${letterTitle.replace(/</g,'&lt;')}</div>
    ${dur ? `<div style="font-size:12px;color:#71717A;margin-bottom:20px;">${dur}</div>` : '<div style="margin-bottom:20px;"></div>'}
    <a href="${link}" style="display:inline-block;background-color:#C4953A;color:#09090B;font-size:15px;font-weight:600;padding:14px 40px;border-radius:50px;text-decoration:none;letter-spacing:0.02em;">&#9654;&ensp;Listen Now</a>
  </td></tr>
  </table>
</td></tr>

<!-- Footer -->
<tr><td style="text-align:center;padding-top:16px;border-top:1px solid #27272A;">
  <span style="color:#52525B;font-size:11px;">Sent with love from Travis via </span><a href="https://fanded.com" style="color:#C4953A;font-size:11px;text-decoration:none;">Fanded</a>
  <br><br>
  <a href="https://fanded.com/unsubscribe" style="color:#52525B;font-size:10px;text-decoration:underline;">Unsubscribe</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
  }

  try {
    const fans = await getFanContacts({ limit, testOnly });
    const results = { sent: 0, failed: 0, errors: [], total: fans.length };

    for (const fan of fans) {
      try {
        const fanName = fan.name || 'there';
        const plainBody = body.replace(/\{\{name\}\}/g, fanName);
        const htmlBody = buildHtmlEmail(body, fanName);
        await sendEmail({
          to: fan.email,
          subject,
          body: plainBody,
          html: htmlBody
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
