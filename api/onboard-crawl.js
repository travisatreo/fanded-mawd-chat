// MAWD Identity Crawl — name-first public footprint scan.
// Given a name, search the public web in parallel across multiple sources,
// weight findings by quality, and have Claude Opus synthesize a warm, factual
// first-person dossier.
//
// POST /api/onboard-crawl
//   body: { name: string, socials?: {...}, fallbackHint?: string }
// Response:
//   { findings: [{source,title,url,snippet,weight}], inferred_role, dossier_text }
//
// Source strategy (parallel):
//   - Tavily Search API (primary): broad LLM-tuned web search, handles Vercel IP
//     blocks cleanly since that's what Tavily is built for. Free tier: 1000/mo.
//   - Wikipedia REST API: best single-source for notable public figures.
//   - Known-platform probes: LinkedIn, Instagram, Twitter/X, YouTube, TikTok,
//     GitHub. Light signal but useful for confirming a handle exists.
//   - DuckDuckGo HTML (legacy backstop): usually blocked on Vercel but cheap
//     to keep in case Tavily is rate-limited or the key is missing.
//
// If TAVILY_API_KEY is not configured, we fall back to Wikipedia + probes
// only (current behavior) and log a warning.

const CACHE = new Map(); // key: normalized name, value: { result, at }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Source weights (1-10). Used in the Claude prompt to help it lead with
// high-signal facts instead of random handle hits.
const SOURCE_WEIGHTS = {
  wikipedia: 10,
  imdb: 9,
  spotify: 9,
  crunchbase: 8,
  linkedin: 8,
  press: 8,       // nyt, forbes, billboard, etc. (detected heuristically)
  tavily: 7,      // general web result from Tavily
  youtube: 6,
  podcast: 6,
  twitter: 5,
  instagram: 5,
  tiktok: 5,
  ddg: 5,
  company: 6,
  github: 3,
  other: 2
};
const PRESS_DOMAINS = /(nytimes|forbes|billboard|rollingstone|variety|deadline|hollywood|techcrunch|bloomberg|wsj|bbc|npr|theverge|wired|pitchfork|stereogum|axios|reuters|gq|vogue|vanityfair)/i;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { name, socials, fallbackHint } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const cacheKey = normalize(name) + (socials ? '|' + JSON.stringify(socials) : '') + (fallbackHint ? '|' + fallbackHint : '');
    const hit = CACHE.get(cacheKey);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
      return res.status(200).json(hit.result);
    }

    // 1. Parallel crawl across all sources
    const findings = await crawlPublicFootprint(name, socials, fallbackHint);

    // 2. Claude Opus synthesis
    const synthesis = await synthesizeDossier(apiKey, name, findings, socials, fallbackHint);

    // 3. Confidence tiering
    const tier = classifyConfidenceTier(findings);

    const result = {
      findings: findings.slice(0, 12).map(f => ({
        source: f.source,
        title: f.title,
        url: f.url,
        snippet: (f.snippet || '').slice(0, 300),
        weight: f.weight
      })),
      inferred_role: synthesis.inferred_role || 'other',
      dossier_text: synthesis.dossier_text || '',
      confidence_tier: tier.tier,
      confidence_debug: tier.debug  // server-side diagnostics; client can ignore
    };

    CACHE.set(cacheKey, { result, at: Date.now() });
    return res.status(200).json(result);
  } catch (err) {
    console.error('onboard-crawl error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function normalize(s){ return String(s||'').toLowerCase().trim().replace(/\s+/g,' '); }

// ── Confidence tiering ─────────────────────────────────────────────────────
// Classify the crawl into one of three tiers to drive UI behavior:
//   high:    3+ unique high-weight source TYPES (e.g. wikipedia + imdb + press).
//            Present dossier confidently, no link ask.
//   medium:  1-2 unique high-weight source types, OR only linkedin/wikipedia
//            alone (risk of stale or narrow). Offer an optional link to sharpen.
//   low:     0 high-weight findings (handle probes only). Ask for a link.
//
// Source types considered "high-weight":
//   wikipedia, imdb, spotify, crunchbase, linkedin, press
// (These are the categories that typically anchor identity claims.)
const HIGH_WEIGHT_TYPES = new Set(['wikipedia', 'imdb', 'spotify', 'crunchbase', 'linkedin', 'press']);

function classifyConfidenceTier(findings) {
  // "Strong anchor" types uniquely identify the person behind the name:
  // IMDb/Spotify/Crunchbase have one page per real entity, and press
  // articles usually discuss one specific person. Wikipedia and LinkedIn
  // are weaker anchors because many people share a name.
  const STRONG_ANCHOR_TYPES = new Set(['imdb', 'spotify', 'crunchbase', 'press']);

  const uniqueHighTypes = new Set();
  const wikipediaEntries = [];
  for (const f of (findings || [])) {
    if (HIGH_WEIGHT_TYPES.has(f.source) && (f.weight || 0) >= 8) {
      uniqueHighTypes.add(f.source);
    }
    if (f.source === 'wikipedia') wikipediaEntries.push(f);
  }

  const hasStrongAnchor = Array.from(uniqueHighTypes).some(t => STRONG_ANCHOR_TYPES.has(t));
  // 3+ wiki hits = likely disambiguation (multiple people share the name),
  // regardless of whether LinkedIn also matched. Promotion to 'high' in
  // this case requires a separate strong anchor (IMDb/Spotify/press).
  const wikipediaAmbiguous = wikipediaEntries.length >= 3;

  let tier = 'low';
  if (uniqueHighTypes.size >= 3) tier = 'high';
  else if (uniqueHighTypes.size >= 2 && hasStrongAnchor) tier = 'high';
  else if (uniqueHighTypes.size >= 1) tier = 'medium';

  // Demotion: even if we hit 'high' by count, if the evidence is a bunch of
  // Wikipedia pages (disambiguation) with no singular anchor, drop to medium.
  if (tier === 'high' && wikipediaAmbiguous && !hasStrongAnchor) tier = 'medium';

  return {
    tier,
    debug: {
      high_types: Array.from(uniqueHighTypes),
      high_type_count: uniqueHighTypes.size,
      has_strong_anchor: hasStrongAnchor,
      wikipedia_entry_count: wikipediaEntries.length,
      wikipedia_ambiguous: wikipediaAmbiguous
    }
  };
}

// ── Public footprint crawl (parallel fan-out) ──────────────────────────────
async function crawlPublicFootprint(name, socials, fallbackHint) {
  const query = [name, socials?.website, fallbackHint].filter(Boolean).join(' ');

  const [tavily, wiki, probes, ddg] = await Promise.all([
    tavilySearch(query, name).catch(err => { console.warn('Tavily skipped:', err.message); return []; }),
    wikipediaLookup(name, fallbackHint).catch(err => { console.warn('Wiki skipped:', err.message); return []; }),
    Promise.all(buildHandleProbes(name).map(probeUrl)).then(r => r.filter(Boolean)).catch(() => []),
    ddgSearch(query, 10).catch(() => [])
  ]);

  let findings = [...tavily, ...wiki, ...probes, ...ddg];

  // If user supplied socials (deepen pass), add as ground-truth anchors.
  if (socials) {
    for (const [k, v] of Object.entries(socials)) {
      if (v) findings.push({
        source: k,
        title: `${k}: ${v}`,
        url: v.startsWith('http') ? v : '',
        snippet: `User-provided ${k} handle.`,
        weight: SOURCE_WEIGHTS[k] || 6
      });
    }
  }

  // Ensure every finding has a weight. Detect press domains for upgraded weighting.
  findings = findings.map(f => {
    if (f.weight !== undefined) return f;
    if (f.source === 'tavily' && PRESS_DOMAINS.test(f.url || '')) {
      return { ...f, source: 'press', weight: SOURCE_WEIGHTS.press };
    }
    return { ...f, weight: SOURCE_WEIGHTS[f.source] || SOURCE_WEIGHTS.other };
  });

  // Deduplicate by URL (first), then source+title
  const seen = new Set();
  findings = findings.filter(f => {
    const key = f.url || (f.source + '|' + f.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by weight desc so highest-signal sources go to Claude first.
  findings.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  return findings;
}

// ── Tavily Search API ──────────────────────────────────────────────────────
// Tavily is built for LLM agents on serverless. One POST returns ranked,
// cleaned results with full title+content. Free tier: 1000 credits/mo.
// Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
async function tavilySearch(query, primaryName) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return []; // silently skip if not configured

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      query: `${primaryName || query} biography`,
      search_depth: 'advanced',
      max_results: 12,
      include_answer: false,
      include_raw_content: false,
      // Bias toward high-quality identity sources. Tavily still returns
      // other domains; this just weights priority.
      include_domains: [
        'wikipedia.org', 'linkedin.com', 'imdb.com', 'spotify.com',
        'open.spotify.com', 'crunchbase.com', 'pitchbook.com',
        'instagram.com', 'youtube.com', 'billboard.com', 'rollingstone.com',
        'variety.com', 'deadline.com', 'techcrunch.com', 'forbes.com'
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Tavily ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(r => {
    const host = hostOf(r.url);
    const source = sourceFromHost(host) || 'tavily';
    return {
      source,
      title: r.title || host,
      url: r.url || '',
      snippet: r.content || '',
      weight: SOURCE_WEIGHTS[source] || SOURCE_WEIGHTS.tavily
    };
  });
}

function hostOf(u){
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch(_) { return ''; }
}
function sourceFromHost(host){
  if (!host) return null;
  if (host.endsWith('wikipedia.org')) return 'wikipedia';
  if (host.endsWith('imdb.com')) return 'imdb';
  if (host.endsWith('spotify.com')) return 'spotify';
  if (host.endsWith('crunchbase.com')) return 'crunchbase';
  if (host.endsWith('pitchbook.com')) return 'crunchbase';
  if (host.endsWith('linkedin.com')) return 'linkedin';
  if (host.endsWith('youtube.com') || host.endsWith('youtu.be')) return 'youtube';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('twitter.com') || host.endsWith('x.com')) return 'twitter';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host.endsWith('github.com')) return 'github';
  if (PRESS_DOMAINS.test(host)) return 'press';
  return null;
}

// ── Wikipedia REST API ─────────────────────────────────────────────────────
async function wikipediaLookup(name, hint) {
  const out = [];
  const candidates = [
    name.trim().replace(/\s+/g, '_'),
    name.trim().split(/\s+/).map(s => s[0] ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s).join('_')
  ];
  const seen = new Set();
  for (const title of candidates) {
    if (!title || seen.has(title)) continue;
    seen.add(title);
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'MAWD/1.0 (https://fanded.com)' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.type === 'disambiguation') {
        out.push({
          source: 'wikipedia',
          title: `Wikipedia disambiguation: ${data.title}`,
          url: data.content_urls?.desktop?.page || url,
          snippet: (data.extract || 'Multiple public figures share this name.').slice(0, 400),
          weight: 4 // lower — ambiguous
        });
      } else if (data.extract) {
        out.push({
          source: 'wikipedia',
          title: `Wikipedia: ${data.title}${data.description ? ' — ' + data.description : ''}`,
          url: data.content_urls?.desktop?.page || url,
          snippet: (data.extract || '').slice(0, 500),
          weight: SOURCE_WEIGHTS.wikipedia
        });
        break;
      }
    } catch (_) { /* try next */ }
  }
  return out;
}

// ── Handle probes ──────────────────────────────────────────────────────────
function buildHandleProbes(name){
  const parts = String(name||'').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    // Single token (e.g. "@travisatreo" → "travisatreo"). Probe as-is.
    const h = String(name||'').replace(/[@\s]/g, '').toLowerCase();
    if (!h) return [];
    return [
      { source:'instagram', url:`https://www.instagram.com/${h}/`, title:`Instagram: @${h}` },
      { source:'twitter',   url:`https://twitter.com/${h}`, title:`X: @${h}` },
      { source:'youtube',   url:`https://www.youtube.com/@${h}`, title:`YouTube: @${h}` },
      { source:'tiktok',    url:`https://www.tiktok.com/@${h}`, title:`TikTok: @${h}` },
      { source:'github',    url:`https://github.com/${h}`, title:`GitHub: @${h}` }
    ];
  }
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  const flat = `${first}${last}`;
  const dot  = `${first}.${last}`;
  const und  = `${first}_${last}`;
  const dash = `${first}-${last}`;
  const urls = [
    { source:'linkedin', url:`https://www.linkedin.com/in/${dash}/`, title:`LinkedIn: /in/${dash}` },
    { source:'instagram', url:`https://www.instagram.com/${flat}/`, title:`Instagram: @${flat}` },
    { source:'instagram', url:`https://www.instagram.com/${dot}/`, title:`Instagram: @${dot}` },
    { source:'instagram', url:`https://www.instagram.com/${und}/`, title:`Instagram: @${und}` },
    { source:'twitter',   url:`https://twitter.com/${flat}`, title:`X: @${flat}` },
    { source:'twitter',   url:`https://twitter.com/${und}`, title:`X: @${und}` },
    { source:'youtube',   url:`https://www.youtube.com/@${flat}`, title:`YouTube: @${flat}` },
    { source:'tiktok',    url:`https://www.tiktok.com/@${flat}`, title:`TikTok: @${flat}` },
    { source:'tiktok',    url:`https://www.tiktok.com/@${und}`, title:`TikTok: @${und}` },
    { source:'github',    url:`https://github.com/${flat}`, title:`GitHub: @${flat}` },
    { source:'github',    url:`https://github.com/${dash}`, title:`GitHub: @${dash}` }
  ];
  return urls;
}

async function probeUrl({ source, url, title }){
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Range': 'bytes=0-16384'
      }
    });
    if (!resp.ok && resp.status !== 206) return null;
    const text = await resp.text().catch(() => '');
    if (/page not found|sorry, this page|this page isn't available|couldn't find this account|user not found/i.test(text)) return null;
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const snippet = titleMatch ? titleMatch[1].trim().slice(0, 200) : 'Handle URL responded.';
    return { source, url, title, snippet, weight: SOURCE_WEIGHTS[source] || 3 };
  } catch(_){}
  return null;
}

// ── DDG backstop (usually blocked on Vercel but cheap to try) ──────────────
async function ddgSearch(query, maxResults) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!resp.ok) return [];
  const html = await resp.text();
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = decodeHtmlEntities(m[1]);
    const realUrl = rewriteDdgRedirect(rawUrl);
    const title = stripTags(m[2]).trim();
    const snippet = stripTags(m[3]).trim();
    if (!title) continue;
    const host = hostOf(realUrl);
    const source = sourceFromHost(host) || 'ddg';
    results.push({
      source,
      title,
      url: realUrl,
      snippet,
      weight: SOURCE_WEIGHTS[source] || SOURCE_WEIGHTS.ddg
    });
  }
  return results;
}

function rewriteDdgRedirect(u){
  try {
    const m = /[?&]uddg=([^&]+)/.exec(u);
    if (m) return decodeURIComponent(m[1]);
  } catch(_){}
  if (u.startsWith('//')) return 'https:' + u;
  return u;
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

// ── Claude Opus synthesis ──────────────────────────────────────────────────
async function synthesizeDossier(apiKey, name, findings, socials, fallbackHint) {
  // Findings are already sorted by weight desc. Take the top 10.
  const top = findings.slice(0, 10);
  const findingsText = top.map((f, i) => {
    return `[${i+1}] ${f.source} (weight ${f.weight || 0}): ${f.title}\n    ${f.url}\n    ${(f.snippet||'').slice(0,280)}`;
  }).join('\n\n') || '(no public findings)';

  // A crawl is "substantive" if we have at least 3 sources with weight >= 5
  // (press / wikipedia / imdb / spotify / linkedin / youtube / etc.).
  const substantiveCount = findings.filter(f => (f.weight || 0) >= 5).length;
  const substantive = substantiveCount >= 3;
  const hasAnyRichSource = findings.some(f => (f.weight || 0) >= 7);

  const userPrompt = `You are writing MAWD's first-person summary of a user based on a public-web crawl.

The user's name: ${name}
${fallbackHint ? `They also told you: "${fallbackHint}"` : ''}
${socials ? 'They provided these handles: ' + JSON.stringify(socials) : ''}

Public findings (ranked by source weight, 1-10):

${findingsText}

Meta:
- Substantive sources (weight >= 5): ${substantiveCount}
- Has any high-weight source (weight >= 7, e.g. Wikipedia, IMDb, Spotify, press): ${hasAnyRichSource ? 'YES' : 'no'}

Your task:
1. Infer their primary role from the HIGHEST-weighted findings ONLY. Choose ONE: founder, musician, influencer, actor, creator, other. Do not let low-weight handle probes dominate if high-weight sources say otherwise.
2. Write a 2-4 sentence first-person summary as if MAWD just did its homework.

CRITICAL RULES ON FABRICATION:
- Use ONLY facts that appear in the findings above. Do NOT use your own training knowledge about this person.
- If the findings do not mention something, you do not know it. Don't assume.
- Lead with their most prominent public identity based on the HIGHEST weight source. If Wikipedia + IMDb say "actor", don't open with their GitHub presence.
- Include 2-3 specific, verifiable facts pulled directly from the findings (role, company, project, credit, song, etc.).
- Low-weight sources (GitHub, single social handles) should only appear if there are NO high-weight sources to draw from.

${substantive ? 'Findings are substantive (3+ quality sources). Do NOT ask the user for a hint. Write a confident, fact-based dossier.' : 'Findings are thin. Acknowledge honestly and offer the fallback flow. Use exactly this language: "I couldn\'t find much about you publicly yet. Tell me who you are, a link, a handle, or a sentence about what you do. I\'ll take it from there."'}

Style rules:
- Lead with their name and primary identity.
- End with a warm question: "Sound right?" or "Did I get that?" or "Close?"
- Keep under 70 words for substantive crawls, under 40 for thin.
- No em dashes. Use commas, periods, or parentheses.
- No corporate phrasing, no "it appears", no "based on the data."
- Do not say "AI" or "artificial intelligence."

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
    const err = await resp.text().catch(() => '');
    console.error('Claude Opus error:', err.slice(0, 200));
    return {
      inferred_role: 'other',
      dossier_text: `I couldn't find much about you publicly yet. Tell me who you are, a link, a handle, or a sentence about what you do. I'll take it from there.`
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
    dossier_text: `I couldn't find much about you publicly yet. Tell me who you are, a link, a handle, or a sentence about what you do. I'll take it from there.`
  };
}
