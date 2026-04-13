// Fanded Podcast Distribution — upload episodes, generate RSS feeds
// Distributes to Apple Podcasts, Spotify, Google via RSS
import { supabaseQuery } from './supabase.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET /api/podcast — list all shows, or ?show=slug for one show's episodes
    if (req.method === 'GET') {
      const { show, episodes } = req.query;

      if (show && episodes) {
        // Get episodes for a specific show
        const eps = await supabaseQuery(
          `podcast_episodes?show_slug=eq.${show}&order=published_at.desc`
        );
        return res.status(200).json(eps);
      }

      if (show) {
        // Get single show details
        const shows = await supabaseQuery(`podcasts?slug=eq.${show}`);
        if (!shows.length) return res.status(404).json({ error: 'Show not found' });
        const episodes = await supabaseQuery(
          `podcast_episodes?show_slug=eq.${show}&order=published_at.desc`
        );
        return res.status(200).json({ ...shows[0], episodes });
      }

      // List all shows
      const shows = await supabaseQuery('podcasts?order=created_at.desc');
      return res.status(200).json(shows);
    }

    // POST /api/podcast — create show or add episode
    if (req.method === 'POST') {
      const { type } = req.body;

      if (type === 'show') {
        const { title, slug, description, author, email, artwork_url, category, language, explicit } = req.body;
        if (!title || !slug) return res.status(400).json({ error: 'title and slug required' });

        const show = await supabaseQuery('podcasts', {
          method: 'POST',
          body: {
            title,
            slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
            description: description || '',
            author: author || 'Fanded',
            email: email || 'hello@fanded.com',
            artwork_url: artwork_url || '',
            category: category || 'Arts',
            language: language || 'en',
            explicit: explicit || false,
            created_at: new Date().toISOString()
          }
        });
        return res.status(201).json(show);
      }

      if (type === 'episode') {
        const { show_slug, title, description, audio_base64, audio_filename, duration_seconds, season, episode_number, explicit } = req.body;
        if (!show_slug || !title) return res.status(400).json({ error: 'show_slug and title required' });

        let audio_url = req.body.audio_url || '';
        let file_size = req.body.file_size || 0;

        // Upload audio to Supabase Storage if base64 provided
        if (audio_base64) {
          const filename = audio_filename || `${Date.now()}-${title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.mp3`;
          const uploadPath = `podcasts/${show_slug}/${filename}`;

          const buffer = Buffer.from(audio_base64, 'base64');
          file_size = buffer.length;

          const uploadRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/podcast/${uploadPath}`,
            {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'audio/mpeg',
                'x-upsert': 'true'
              },
              body: buffer
            }
          );

          if (!uploadRes.ok) {
            const err = await uploadRes.text();
            return res.status(500).json({ error: 'Audio upload failed: ' + err });
          }

          audio_url = `${SUPABASE_URL}/storage/v1/object/public/podcast/${uploadPath}`;
        }

        const episode = await supabaseQuery('podcast_episodes', {
          method: 'POST',
          body: {
            show_slug,
            title,
            description: description || '',
            audio_url,
            file_size,
            duration_seconds: duration_seconds || 0,
            season: season || 1,
            episode_number: episode_number || null,
            explicit: explicit || false,
            published_at: new Date().toISOString(),
            guid: `fanded-${show_slug}-${Date.now()}`
          }
        });

        return res.status(201).json({
          ...episode,
          feed_url: `https://fanded-mawd-chat.vercel.app/api/feed?show=${show_slug}`
        });
      }

      return res.status(400).json({ error: 'type must be "show" or "episode"' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Podcast API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
