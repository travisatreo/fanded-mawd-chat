// MAWD Identity Crawl — name-first public footprint scan.
// Pre-OAuth discovery: given just a name, search the public web,
// synthesize a dossier, and infer the user's primary role.
//
// POST /api/onboard-crawl
//   body: { name: string, socials?: {...} }
// Response:
//   { findings: [{source,title,url,snippet}], inferred_role, dossier_text }
//
// When `socials` is present this runs a "deepen" pass: it re-synthesizes
// using the provided handles as additional anchors.

const CACHE = new Map(); // key: normalized name, value: { result, at }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { name, socials, fallbackHint } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const cacheKey = normalize(name) + (socials ? '|' + JSON.stringify(socials) : '') + (fallbackHint ? '|' + fallbackHint : '');
    const hit = CACHE.get(cacheKey);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
      return res.status(200).json(hit.result);
    }

    // 1. Crawl DDG HTML for the name. If it returns nothing, probe predictable handle URLs.
    const findings = await crawlPublicFootprint(name, socials, fallbackHint);

    // 2. Claude Opus synthesis: dossier + inferred role
    const synthesis = await synthesizeDossier(apiKey, name, findings, socials, fallbackHint);

    const result = {
      findings: findings.slice(0, 10).map(f => ({
        source: f.source,
        title: f.title,
        url: f.url,
        snippet: (f.snippet || '').slice(0, 280)
      })),
      inferred_role: synthesis.inferred_role || 'other',
      dossier_text: synthesis.dossier_text || ''
    };

    CACHE.set(cacheKey, { result, at: Date.now() });
    return res.status(200).json(result);
  } catch (err) {
    console.error('onboard-crawl error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function normalize(s){ return String(s||'').toLowerCase().trim().replace(/\s+/g,' '); }

// ── Public footprint crawl ─────────────────────────────────────────────────
async function crawlPublicFootprint(name, socials, fallbackHint) {
  // Run all sources in parallel. DDG blocks many serverless IPs; we used to
  // fall back to handle probes only when DDG returned <3 results, but that
  // means a Vercel-blocked DDG silently produced near-empty dossiers. Now
  // everything fires at once.
  const query = [name, socials?.website, fallbackHint].filter(Boolean).join(' ');
  const [ddg, wiki, probes] = await Promise.all([
    ddgSearch(query, 10).catch(err => { console.error('DDG failed:', err.message); return []; }),
    wikipediaLookup(name, fallbackHint).catch(err => { console.error('Wiki failed:', err.message); return []; }),
    Promise.all(buildHandleProbes(name).map(probeUrl)).then(r => r.filter(Boolean)).catch(() => [])
  ]);

  const findings = [...ddg, ...wiki, ...probes];

  // If user supplied socials (deepen pass), add them as ground-truth anchors
  if (socials) {
    for (const [k, v] of Object.entries(socials)) {
      if (v) findings.push({ source: k, title: `${k}: ${v}`, url: v.startsWith('http') ? v : '', snippet: `User-provided ${k} handle.` });
    }
  }

  // Deduplicate by URL, then source+title
  const seen = new Set();
  return findings.filter(f => {
    const key = f.url || (f.source + '|' + f.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Wikipedia REST API. Free, unauth, returns structured JSON including
// extract (first paragraph) and description. Best single public source
// for real public figures.
async function wikipediaLookup(name, hint) {
  const out = [];
  const candidates = [
    name.trim().replace(/\s+/g, '_'),
    name.trim().split(/\s+/).map(s => s[0].toUpperCase() + s.slice(1).toLowerCase()).join('_')
  ];
  const seen = new Set();
  for (const title of candidates) {
    if (seen.has(title)) continue;
    seen.add(title);
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'MAWD/1.0 (https://fanded.com)' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.type === 'disambiguation') {
        // Disambiguation page = name matches multiple people. Useful signal.
        out.push({
          source: 'wikipedia',
          title: `Wikipedia disambiguation: ${data.title}`,
          url: data.content_urls?.desktop?.page || url,
          snippet: (data.extract || 'Multiple public figures share this name.').slice(0, 300)
        });
      } else if (data.extract) {
        out.push({
          source: 'wikipedia',
          title: `Wikipedia: ${data.title}${data.description ? ' — ' + data.description : ''}`,
          url: data.content_urls?.desktop?.page || url,
          snippet: (data.extract || '').slice(0, 400)
        });
        break; // First hit wins
      }
    } catch (_) { /* try next */ }
  }
  return out;
}

async function ddgSearch(query, maxResults) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!resp.ok) throw new Error('DDG status ' + resp.status);
  const html = await resp.text();

  // Parse result blocks
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = decodeHtmlEntities(m[1]);
    const realUrl = rewriteDdgRedirect(rawUrl);
    const title = stripTags(m[2]).trim();
    const snippet = stripTags(m[3]).trim();
    if (!title) continue;
    results.push({
      source: sourceFromUrl(realUrl),
      title: title,
      url: realUrl,
      snippet: snippet
    });
  }
  return results;
}

function rewriteDdgRedirect(u){
  // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<ENCODED>&...
  try {
    const m = /[?&]uddg=([^&]+)/.exec(u);
    if (m) return decodeURIComponent(m[1]);
  } catch(_){}
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

function sourceFromUrl(u){
  try {
    const host = new URL(u.startsWith('http') ? u : ('https:' + u)).hostname.replace(/^www\./,'');
    return host.split('.')[0];
  } catch(_) { return 'web'; }
}

function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' '); }
function decodeHtmlEntities(s){
  return String(s||'')
    .replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&#x2F;/g,'/');
}

function buildHandleProbes(name){
  const parts = String(name||'').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  const flat = `${first}${last}`;
  const dot  = `${first}.${last}`;
  const und  = `${first}_${last}`;
  const dash = `${first}-${last}`;
  // Build probes. Platform ordering prioritizes richer identity signal first.
  const urls = [];
  // Wikipedia-like handle convention not a real probe (covered by wiki API).
  // LinkedIn: most profiles use first-last
  urls.push({ source:'linkedin', url:`https://www.linkedin.com/in/${dash}/`, title:`LinkedIn: /in/${dash}` });
  // Instagram
  urls.push({ source:'instagram', url:`https://www.instagram.com/${flat}/`, title:`Instagram: @${flat}` });
  urls.push({ source:'instagram', url:`https://www.instagram.com/${dot}/`, title:`Instagram: @${dot}` });
  urls.push({ source:'instagram', url:`https://www.instagram.com/${und}/`, title:`Instagram: @${und}` });
  // X / Twitter
  urls.push({ source:'twitter',   url:`https://twitter.com/${flat}`, title:`X: @${flat}` });
  urls.push({ source:'twitter',   url:`https://twitter.com/${und}`, title:`X: @${und}` });
  // YouTube
  urls.push({ source:'youtube',   url:`https://www.youtube.com/@${flat}`, title:`YouTube: @${flat}` });
  urls.push({ source:'youtube',   url:`https://www.youtube.com/@${first}${last}`, title:`YouTube: @${first}${last}` });
  // TikTok
  urls.push({ source:'tiktok',    url:`https://www.tiktok.com/@${flat}`, title:`TikTok: @${flat}` });
  urls.push({ source:'tiktok',    url:`https://www.tiktok.com/@${und}`, title:`TikTok: @${und}` });
  // GitHub (useful for founder / engineer signal)
  urls.push({ source:'github',    url:`https://github.com/${flat}`, title:`GitHub: @${flat}` });
  urls.push({ source:'github',    url:`https://github.com/${dash}`, title:`GitHub: @${dash}` });
  return urls;
}

async function probeUrl({ source, url, title }){
  try {
    // Use GET with range to confirm real pages (HEAD often returns 200 even
    // for "user not found" pages on LinkedIn / Instagram which are SPA).
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Range': 'bytes=0-16384' // Just the head of the HTML
      }
    });
    if (!resp.ok && resp.status !== 206) return null;
    const text = await resp.text().catch(() => '');
    // Reject known "user not found" heuristics
    if (/page not found|sorry, this page|404|couldn't find this account|user not found/i.test(text)) return null;
    // Try to extract <title>
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const snippet = titleMatch ? titleMatch[1].trim().slice(0, 200) : 'Handle URL responded.';
    return { source, url, title, snippet };
  } catch(_){}
  return null;
}

// ── Claude Opus synthesis ──────────────────────────────────────────────────
async function synthesizeDossier(apiKey, name, findings, socials, fallbackHint) {
  const findingsText = findings.slice(0, 10).map((f, i) => {
    return `[${i+1}] ${f.source}: ${f.title}\n    ${f.url}\n    ${(f.snippet||'').slice(0,240)}`;
  }).join('\n\n') || '(no public findings)';

  const hasRichFindings = findings.some(f => f.source === 'wikipedia' || (f.snippet && f.snippet.length > 80));

  const userPrompt = `You are writing MAWD's first-person summary of a user based on a public-web crawl.

The user's name: ${name}
${fallbackHint ? `They also told you: "${fallbackHint}"` : ''}
${socials ? 'They provided these handles: ' + JSON.stringify(socials) : ''}

Here are the public findings (DuckDuckGo results + Wikipedia lookup + handle probes):

${findingsText}

Your task:
1. Infer their primary role from these findings ONLY. Choose ONE: founder, musician, influencer, actor, creator, other.
2. Write a 2-4 sentence first-person summary as if MAWD just did its homework.

CRITICAL RULES ON FABRICATION:
- Use ONLY facts that appear in the findings above. Do NOT use your own training knowledge about this person.
- If the findings do not mention something, you do not know it. Don't assume. Don't guess.
- "${hasRichFindings ? 'Findings are usable.' : 'Findings are thin.'}"
- If findings contain ONLY handle probes (Instagram/Twitter/YouTube URLs with no descriptive context), the crawl is WEAK. Say so honestly and ask for a hint. Example: "Your name turns up a few handles (@${name.toLowerCase().replace(/\s+/g,'')} on a couple of platforms), but the open web didn't give me much about what you actually do. Drop me a link or a sentence and I'll sharpen this."
- If findings contain a Wikipedia extract or substantive DDG snippets, use them. Include 1-2 specific verifiable facts (role, company, project) directly from the findings text.

Style rules:
- Lead with their name and primary identity.
- End with a warm question: "Sound right?" or "Did I get that?" or "Close?"
- Keep under 60 words.
- No em dashes. Use commas, periods, or parentheses.
- No corporate phrasing, no "it appears", no "based on the data."
- Never say "AI" or "artificial intelligence."
- If findings are empty: "I couldn't pin you down from the open web. Tell me what you do and I'll try again."

Respond ONLY with valid JSON in this shape:
{
  "inferred_role": "founder" | "musician" | "influencer" | "actor" | "creator" | "other",
  "dossier_text": "..."
}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Claude Opus error:', err);
    return {
      inferred_role: 'other',
      dossier_text: `I couldn't pin you down from the open web. Tell me what you do and I'll try again.`
    };
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.dossier_text && parsed.inferred_role) return parsed;
    }
  } catch (_) {}

  return {
    inferred_role: 'other',
    dossier_text: `I couldn't pin you down from the open web. Tell me what you do and I'll try again.`
  };
}
