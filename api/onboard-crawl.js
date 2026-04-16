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
  const findings = [];

  // Step A: DuckDuckGo HTML search (no API key required)
  try {
    const query = [name, socials?.website, fallbackHint].filter(Boolean).join(' ');
    const ddg = await ddgSearch(query, 10);
    findings.push(...ddg);
  } catch (e) {
    console.error('DDG failed:', e.message);
  }

  // Step B: predictable handle probes (only if DDG was weak)
  if (findings.length < 3) {
    const probes = buildHandleProbes(name);
    const probeResults = await Promise.all(probes.map(probeUrl));
    findings.push(...probeResults.filter(Boolean));
  }

  // Step C: if user supplied socials (deepen pass), add them as ground-truth anchors
  if (socials) {
    for (const [k, v] of Object.entries(socials)) {
      if (v) findings.push({ source: k, title: `${k}: ${v}`, url: v.startsWith('http') ? v : '', snippet: `User-provided ${k} handle.` });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return findings.filter(f => {
    const key = f.url || (f.source + '|' + f.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const variants = [
    `${first}${last}`,
    `${first}.${last}`,
    `${first}_${last}`,
    `${first}-${last}`
  ];
  const urls = [];
  for (const h of variants) {
    urls.push({ source:'linkedin', url:`https://www.linkedin.com/in/${h}/`, title:`LinkedIn: /in/${h}` });
    urls.push({ source:'instagram', url:`https://www.instagram.com/${h}/`, title:`Instagram: @${h}` });
    urls.push({ source:'twitter', url:`https://twitter.com/${h}`, title:`X: @${h}` });
  }
  return urls;
}

async function probeUrl({ source, url, title }){
  try {
    const resp = await fetch(url, { method:'HEAD', redirect:'follow' });
    if (resp.ok) return { source, url, title, snippet:'Handle URL responded (public profile likely exists).' };
  } catch(_){}
  return null;
}

// ── Claude Opus synthesis ──────────────────────────────────────────────────
async function synthesizeDossier(apiKey, name, findings, socials, fallbackHint) {
  const findingsText = findings.slice(0, 10).map((f, i) => {
    return `[${i+1}] ${f.source}: ${f.title}\n    ${f.url}\n    ${(f.snippet||'').slice(0,240)}`;
  }).join('\n\n') || '(no public findings)';

  const userPrompt = `You are writing MAWD's first-person summary of a user based on a public-web crawl.

The user's name: ${name}
${fallbackHint ? `They also told you: "${fallbackHint}"` : ''}
${socials ? 'They provided these handles: ' + JSON.stringify(socials) : ''}

Here are the public findings from DuckDuckGo + handle probes:

${findingsText}

Your task:
1. Infer their primary role from these findings. Choose ONE: founder, musician, influencer, actor, creator, other.
2. Write a 2-4 sentence first-person summary as if MAWD just did its homework. Lead with their name and primary identity. Include 2-3 specific, verifiable facts from the findings (don't invent anything). End with a warm question like "Sound right?" or "Did I get that?"

Rules:
- Keep under 60 words.
- No corporate phrasing, no "it appears", no "based on the data."
- No em dashes. Use commas, periods, or parentheses.
- Never say "AI" or "artificial intelligence."
- If findings are sparse, say so honestly: "I couldn't pin you down from the open web. Tell me what you do and I'll try again."

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
