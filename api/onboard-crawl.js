// MAWD Onboard Crawl — web-crawls public data, synthesizes brain, generates aha moment + 3 options
// POST: { name, socials: { youtube, instagram, tiktok, spotify, twitter }, focus }
// Returns: { synthesis, insight, options: [{title, description}], crawledData }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { name, socials, focus } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    // Step 1: Crawl public data from social profiles
    const crawledData = await crawlPublicData(name, socials || {});

    // Step 2: Send to Claude for synthesis, insight, and 3 personalized options
    const analysis = await synthesizeWithClaude(apiKey, name, crawledData, focus);

    return res.status(200).json({
      crawledData: crawledData.summary,
      ...analysis
    });
  } catch (err) {
    console.error('Onboard crawl error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Crawl public data from social links and web search
async function crawlPublicData(name, socials) {
  const results = [];
  const summary = {};

  // Web search for the person's name
  try {
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&q=${encodeURIComponent(name + ' artist OR creator OR musician')}&num=5`;
    const searchRes = await fetch(searchUrl);
    if (searchRes.ok) {
      const data = await searchRes.json();
      if (data.items) {
        summary.webResults = data.items.map(i => ({ title: i.title, snippet: i.snippet, link: i.link }));
        results.push('WEB SEARCH RESULTS:\n' + data.items.map(i => `- ${i.title}: ${i.snippet}`).join('\n'));
      }
    }
  } catch (e) {
    // If Google Search API not configured, use name only
    results.push(`WEB SEARCH: API not configured. Using name "${name}" for analysis.`);
  }

  // YouTube channel data (public API)
  if (socials.youtube) {
    try {
      const ytData = await fetchYouTubePublic(socials.youtube);
      if (ytData) {
        summary.youtube = ytData;
        results.push('YOUTUBE DATA:\n' + JSON.stringify(ytData));
      }
    } catch (e) {
      results.push(`YOUTUBE: Could not fetch data for ${socials.youtube}`);
    }
  }

  // Instagram (public profile scrape via page fetch)
  if (socials.instagram) {
    try {
      const handle = socials.instagram.replace(/.*instagram\.com\//, '').replace(/[/@]/g, '').trim();
      summary.instagram = { handle, provided: true };
      results.push(`INSTAGRAM: @${handle} (profile link provided)`);
    } catch (e) {
      results.push(`INSTAGRAM: Could not process ${socials.instagram}`);
    }
  }

  // TikTok
  if (socials.tiktok) {
    const handle = socials.tiktok.replace(/.*tiktok\.com\/@?/, '').replace(/[/@]/g, '').trim();
    summary.tiktok = { handle, provided: true };
    results.push(`TIKTOK: @${handle} (profile link provided)`);
  }

  // Spotify
  if (socials.spotify) {
    summary.spotify = { link: socials.spotify, provided: true };
    results.push(`SPOTIFY: ${socials.spotify} (profile link provided)`);
  }

  // Twitter/X
  if (socials.twitter) {
    const handle = socials.twitter.replace(/.*(?:twitter|x)\.com\//, '').replace(/[/@]/g, '').trim();
    summary.twitter = { handle, provided: true };
    results.push(`TWITTER/X: @${handle} (profile link provided)`);
  }

  return { raw: results.join('\n\n'), summary };
}

// Fetch YouTube public data via Data API
async function fetchYouTubePublic(ytLink) {
  const ytKey = process.env.YOUTUBE_API_KEY;
  if (!ytKey) return { link: ytLink, note: 'YouTube API key not configured' };

  // Extract channel handle or ID from URL
  let channelId = null;
  const match = ytLink.match(/(?:channel\/|c\/|@)([\w-]+)/);
  if (match) {
    // Try to resolve handle to channel ID
    const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?key=${ytKey}&q=${encodeURIComponent(match[1])}&type=channel&part=snippet&maxResults=1`);
    if (searchRes.ok) {
      const data = await searchRes.json();
      if (data.items && data.items.length > 0) {
        channelId = data.items[0].id.channelId;
      }
    }
  }

  if (!channelId) return { link: ytLink, note: 'Could not resolve channel' };

  // Get channel stats
  const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?key=${ytKey}&id=${channelId}&part=statistics,snippet`);
  if (!statsRes.ok) return { link: ytLink, note: 'Could not fetch stats' };

  const statsData = await statsRes.json();
  if (!statsData.items || !statsData.items.length) return { link: ytLink, note: 'No channel data found' };

  const ch = statsData.items[0];
  return {
    name: ch.snippet.title,
    subscribers: parseInt(ch.statistics.subscriberCount),
    totalViews: parseInt(ch.statistics.viewCount),
    videoCount: parseInt(ch.statistics.videoCount),
    description: ch.snippet.description?.substring(0, 300)
  };
}

// Use Claude to synthesize crawled data into insight + options
async function synthesizeWithClaude(apiKey, name, crawledData, focus) {
  const prompt = `You are MAWD, an AI chief of staff that just finished scanning public data about ${name}.

Here is what was found:
${crawledData.raw}

${focus ? `They said their current focus is: "${focus}"` : 'They haven\'t specified a focus area yet.'}

Your job:
1. Write a SHORT synthesis (2-3 sentences max) of what you found about ${name} and their business/career. Be specific with any numbers you found.
2. Surface ONE genuinely interesting insight they probably don't know or haven't thought about. This should feel like "wait, how did you know that?" Make it specific and actionable, not generic.
3. Generate exactly 3 personalized options for "What do you want to tackle first?" Each option should be:
   - Based on what you actually found in the crawl data
   - Specific to their situation (not generic business advice)
   - Framed as something MAWD can help with RIGHT NOW
   - Short title (2-4 words) + one sentence description

IMPORTANT: Be direct and confident. No hedging. No "it appears" or "it seems". State facts.
If the crawl data is limited, use what you have and be honest about what you'd learn with more data.

Respond in this exact JSON format:
{
  "synthesis": "...",
  "insight": "...",
  "options": [
    { "emoji": "...", "title": "...", "description": "..." },
    { "emoji": "...", "title": "...", "description": "..." },
    { "emoji": "...", "title": "...", "description": "..." }
  ]
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API error: ' + err);
  }

  const data = await response.json();
  const text = data.content[0].text;

  // Parse JSON from response
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Fallback if JSON parsing fails
  }

  return {
    synthesis: `I found public information about ${name}. Connect more data sources and I'll get sharper.`,
    insight: 'Link your social profiles and I\'ll surface patterns you can\'t see from inside the day-to-day.',
    options: [
      { emoji: '💰', title: 'Money Map', description: 'Let me trace every revenue stream and find what\'s leaking.' },
      { emoji: '📊', title: 'Content Strategy', description: 'I\'ll analyze your content patterns and show you what to double down on.' },
      { emoji: '⏰', title: 'Time Audit', description: 'Link your calendar and I\'ll find the hours you\'re losing every week.' }
    ]
  };
}
