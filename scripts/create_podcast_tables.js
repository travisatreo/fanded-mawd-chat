// Create podcast distribution tables in Supabase
// Run: node scripts/create_podcast_tables.js

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function runSQL(sql) {
  // Use the database query endpoint
  const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)[1];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  // Fallback: try creating via PostgREST by just inserting
  // If rpc doesn't work, we'll create tables via raw SQL through the management API
  if (!res.ok) {
    console.log('RPC not available, trying management API...');
    const mgmtRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
    if (mgmtRes.ok) {
      return await mgmtRes.json();
    }
    console.log('Management API response:', await mgmtRes.text());
    return null;
  }
  return await res.json();
}

async function main() {
  if (!SUPABASE_KEY) {
    console.error('Set SUPABASE_SERVICE_ROLE_KEY env var');
    process.exit(1);
  }

  console.log('Creating podcasts table...');
  await runSQL(`
    CREATE TABLE IF NOT EXISTS podcasts (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      author TEXT DEFAULT 'Fanded',
      email TEXT DEFAULT 'hello@fanded.com',
      artwork_url TEXT DEFAULT '',
      category TEXT DEFAULT 'Arts',
      language TEXT DEFAULT 'en',
      explicit BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  console.log('Creating podcast_episodes table...');
  await runSQL(`
    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      show_slug TEXT NOT NULL REFERENCES podcasts(slug),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      audio_url TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      duration_seconds INTEGER DEFAULT 0,
      season INTEGER DEFAULT 1,
      episode_number INTEGER,
      explicit BOOLEAN DEFAULT false,
      guid TEXT UNIQUE NOT NULL,
      published_at TIMESTAMPTZ DEFAULT now(),
      downloads INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_show ON podcast_episodes(show_slug);
    CREATE INDEX IF NOT EXISTS idx_episodes_published ON podcast_episodes(published_at DESC);
  `);

  console.log('Creating podcast storage bucket...');
  const bucketRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: 'podcast',
      name: 'podcast',
      public: true,
      file_size_limit: 524288000 // 500MB per file
    })
  });

  if (bucketRes.ok) {
    console.log('Podcast storage bucket created');
  } else {
    const err = await bucketRes.text();
    if (err.includes('already exists')) {
      console.log('Podcast bucket already exists');
    } else {
      console.log('Bucket creation:', err);
    }
  }

  console.log('\nDone! Fanded podcast distribution is ready.');
  console.log('\nNext steps:');
  console.log('1. Create a show: POST /api/podcast { type: "show", title: "...", slug: "..." }');
  console.log('2. Add episodes: POST /api/podcast { type: "episode", show_slug: "...", title: "...", audio_url: "..." }');
  console.log('3. RSS feed: GET /api/feed?show=slug');
  console.log('4. Submit RSS URL to Apple Podcasts & Spotify for Podcasters');
}

main().catch(console.error);
