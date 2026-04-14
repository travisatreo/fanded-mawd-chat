// RSS Feed Generator for Fanded Podcast Distribution
// Generates Apple Podcasts / Spotify compatible RSS XML
// Usage: /api/feed?show=slug
import { supabaseQuery } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { show } = req.query;
  if (!show) return res.status(400).send('Missing ?show= parameter');

  try {
    // Get show details
    const shows = await supabaseQuery(`podcasts?slug=eq.${show}`);
    if (!shows.length) return res.status(404).send('Show not found');
    const podcast = shows[0];

    // Get episodes
    const episodes = await supabaseQuery(
      `podcast_episodes?show_slug=eq.${show}&order=published_at.desc`
    );

    // Build RSS XML
    const xml = buildRSS(podcast, episodes);

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=900'); // 15 min cache
    return res.status(200).send(xml);
  } catch (err) {
    console.error('Feed error:', err);
    return res.status(500).send('Feed generation failed');
  }
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDuration(seconds) {
  if (!seconds) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toUTCString();
}

function buildRSS(podcast, episodes) {
  const feedUrl = `https://fanded-mawd-chat.vercel.app/api/feed?show=${podcast.slug}`;
  const siteUrl = `https://fanded-mawd-chat.vercel.app/show/${podcast.slug}`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>${escapeXml(podcast.title)}</title>
  <description>${escapeXml(podcast.description)}</description>
  <link>${siteUrl}</link>
  <language>${podcast.language || 'en'}</language>
  <copyright>Copyright ${new Date().getFullYear()} ${escapeXml(podcast.author)}</copyright>
  <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${formatDate(new Date().toISOString())}</lastBuildDate>
  <itunes:author>${escapeXml(podcast.author)}</itunes:author>
  <itunes:summary>${escapeXml(podcast.description)}</itunes:summary>
  <itunes:owner>
    <itunes:name>${escapeXml(podcast.author)}</itunes:name>
    <itunes:email>${escapeXml(podcast.email || 'hello@fanded.com')}</itunes:email>
  </itunes:owner>
  <itunes:explicit>${podcast.explicit ? 'true' : 'false'}</itunes:explicit>
  <itunes:category text="${escapeXml(podcast.category || 'Arts')}"/>
  <itunes:type>episodic</itunes:type>`;

  if (podcast.artwork_url) {
    xml += `
  <itunes:image href="${escapeXml(podcast.artwork_url)}"/>
  <image>
    <url>${escapeXml(podcast.artwork_url)}</url>
    <title>${escapeXml(podcast.title)}</title>
    <link>${siteUrl}</link>
  </image>`;
  }

  xml += `
  <podcast:locked>no</podcast:locked>
  <podcast:medium>podcast</podcast:medium>`;

  // Episodes
  for (const ep of episodes) {
    xml += `
  <item>
    <title>${escapeXml(ep.title)}</title>
    <description>${escapeXml(ep.description)}</description>
    <content:encoded><![CDATA[${ep.description || ''}]]></content:encoded>
    <enclosure url="${escapeXml(ep.audio_url)}" length="${ep.file_size || 0}" type="audio/mpeg"/>
    <guid isPermaLink="false">${escapeXml(ep.guid)}</guid>
    <pubDate>${formatDate(ep.published_at)}</pubDate>
    <itunes:title>${escapeXml(ep.title)}</itunes:title>
    <itunes:summary>${escapeXml(ep.description)}</itunes:summary>
    <itunes:duration>${formatDuration(ep.duration_seconds)}</itunes:duration>
    <itunes:explicit>${ep.explicit ? 'true' : 'false'}</itunes:explicit>
    <itunes:episodeType>full</itunes:episodeType>`;

    if (ep.season) xml += `\n    <itunes:season>${ep.season}</itunes:season>`;
    if (ep.episode_number) xml += `\n    <itunes:episode>${ep.episode_number}</itunes:episode>`;

    xml += `
  </item>`;
  }

  xml += `
</channel>
</rss>`;

  return xml;
}
