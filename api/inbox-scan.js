// MAWD Inbox Scan — reads Gmail inbox, asks Claude to extract people/threads
// that matter, and returns a role-adapted dossier (metrics + insights).
// GET /api/inbox-scan?role=founder&owner=user@example.com
import { listEmails } from '../lib/google.js';
import { supabaseQuery } from '../lib/supabase.js';

const ROLE_PROMPTS = {
  founder: {
    metricLabels: ['INVESTORS PITCHED', 'DORMANT THREADS', 'WAITING ON YOU'],
    instruction: 'You are reading a founder\'s inbox. Identify: investor conversations (any VC, angel, fund), past clients who have gone cold, and warm threads that need a reply. For each insight, include a specific person name and the context (e.g., "asked for an update 23 days ago"). Return people who sound like they could move the raise or pipeline forward.'
  },
  influencer: {
    metricLabels: ['BRAND CONVERSATIONS', 'COLD DEALS', 'AGENCY PITCHES'],
    instruction: 'You are reading an influencer\'s inbox. Identify: brand deal conversations (any sponsorship, campaign, product pitch), deals that stalled mid-negotiation, and agency/manager pitches. For each insight, name the specific brand or person and what they were discussing.'
  },
  actor: {
    metricLabels: ['CASTING CONVERSATIONS', 'PROJECTS DISCUSSED', 'REPS AND MANAGERS'],
    instruction: 'You are reading an actor\'s inbox. Identify: casting director conversations, producer or writer pitches about projects, and communications from reps, managers, lawyers. Name the specific person and what project or role they discussed.'
  },
  musician: {
    metricLabels: ['COLLABORATORS', 'SYNC OR LICENSING', 'VENUE OR PROMOTER'],
    instruction: 'You are reading a musician\'s inbox. Identify: other artists or producers discussing collabs, sync licensing threads (music supervisors, ad agencies, film people), and venue/promoter conversations. Name the specific person and the project or show they mentioned.'
  },
  other: {
    metricLabels: ['PEOPLE WHO PAID YOU', 'WARM THREADS', 'WAITING ON YOU'],
    instruction: 'You are reading a professional\'s inbox. Identify: people who have paid this person for work, warm threads where the relationship is active, and threads where someone is waiting on a reply. Name the specific person and what the thread was about.'
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const role = (req.query.role || 'other').toLowerCase();
    const ownerEmail = req.query.owner || '';
    const config = ROLE_PROMPTS[role] || ROLE_PROMPTS.other;

    // Look up refresh token for this owner
    let refreshToken = null;
    if (ownerEmail) {
      try {
        const rows = await supabaseQuery(`mawd_instances?email=eq.${encodeURIComponent(ownerEmail)}`);
        if (rows && rows.length && rows[0].gmail_refresh_token) {
          refreshToken = rows[0].gmail_refresh_token;
        }
      } catch (_) { /* ignore */ }
    }

    if (!refreshToken) {
      return res.status(200).json({ needsConnect: true, dossier: null });
    }

    // Pull ~40 recent emails
    let emails = [];
    try {
      emails = await listEmails({ maxResults: 40, _refreshToken: refreshToken });
    } catch (err) {
      return res.status(200).json({ needsConnect: true, error: 'Gmail read failed', dossier: null });
    }

    if (!emails || !emails.length) {
      return res.status(200).json({ dossier: emptyDossier(config) });
    }

    // Compress email list for Claude
    const compact = emails.map(e => ({
      from: e.from || '',
      subject: e.subject || '',
      snippet: (e.snippet || '').slice(0, 200),
      date: e.date || e.internalDate || ''
    })).slice(0, 40);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ dossier: fallbackDossier(config, compact) });
    }

    const userPrompt = `${config.instruction}\n\nHere are the ${compact.length} most recent emails:\n\n${JSON.stringify(compact, null, 2)}\n\nReturn ONLY valid JSON in this exact shape:\n{\n  "metrics": [\n    {"value": "12", "label": "${config.metricLabels[0]}"},\n    {"value": "4", "label": "${config.metricLabels[1]}"},\n    {"value": "7", "label": "${config.metricLabels[2]}"}\n  ],\n  "insights": [\n    {"tag": "COLD", "tagClass": "t-warn", "headline": "Jane Doe from Acme asked for a product demo 18 days ago.", "sub": "Last reply: you on March 28. Draft a re-engage?", "draftTarget": {"to": "jane@acme.com", "subject": "Quick follow-up", "body": "Hi Jane, circling back on the demo we discussed...", "context": "Cold 18d"}}\n  ]\n}\n\nReturn 4-7 insights. Each insight must reference a REAL person or brand from the emails above. Use their actual email address in draftTarget.to. The draft body should be 2-3 sentences, warm, in first person. No em dashes. Values in metrics should be real counts from the data.`;

    let claudeText = null;
    try {
      const anthResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 2500,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      const anthData = await anthResp.json();
      claudeText = anthData && anthData.content && anthData.content[0] && anthData.content[0].text;
    } catch (err) {
      console.error('Claude call failed:', err.message);
    }

    let dossier = null;
    if (claudeText) {
      const jsonMatch = claudeText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { dossier = JSON.parse(jsonMatch[0]); } catch (_) { /* fall through */ }
      }
    }

    if (!dossier || !dossier.insights) {
      dossier = fallbackDossier(config, compact);
    }

    // Attach ids to insights
    dossier.insights = (dossier.insights || []).map((ins, i) => Object.assign({}, ins, {
      id: 'ins_' + Date.now() + '_' + i
    }));

    return res.status(200).json({ dossier });
  } catch (err) {
    console.error('inbox-scan error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function emptyDossier(config) {
  return {
    metrics: config.metricLabels.map(l => ({ value: '0', label: l })),
    insights: [{
      id: 'ins_empty',
      tag: 'EMPTY',
      tagClass: 't-pulse',
      headline: 'Your inbox is clean right now.',
      sub: 'MAWD will surface new threads here as they come in.'
    }]
  };
}

function fallbackDossier(config, emails) {
  // Deterministic fallback: group by sender, surface top-5 senders with recent activity
  const bySender = {};
  emails.forEach(e => {
    const m = /<([^>]+)>/.exec(e.from) || [null, e.from];
    const addr = (m[1] || e.from || '').trim();
    const name = (e.from || '').replace(/<[^>]+>/, '').replace(/"/g, '').trim() || addr;
    if (!addr) return;
    if (!bySender[addr]) bySender[addr] = { name, addr, count: 0, recent: e.subject };
    bySender[addr].count++;
  });
  const top = Object.values(bySender).sort((a, b) => b.count - a.count).slice(0, 5);
  return {
    metrics: [
      { value: String(emails.length), label: config.metricLabels[0] },
      { value: String(top.length), label: config.metricLabels[1] },
      { value: String(Math.max(0, emails.length - top.length)), label: config.metricLabels[2] }
    ],
    insights: top.map((t, i) => ({
      id: 'ins_fb_' + i,
      tag: 'INBOX',
      tagClass: 't-metric',
      headline: t.name + ' has ' + t.count + ' recent thread' + (t.count > 1 ? 's' : '') + '.',
      sub: 'Last subject: ' + (t.recent || ''),
      draftTarget: {
        to: t.addr,
        subject: 'Catching up',
        body: 'Hey, wanted to circle back on our last thread. Free this week to sync?',
        context: 'Re-engage'
      }
    }))
  };
}
