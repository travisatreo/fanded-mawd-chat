# Path A — Environment Variables

Everything the 5-rung onboarding needs, with setup steps. All keys add
to Vercel → Project Settings → Environment Variables for all three
environments (Production, Preview, Development), then redeploy.

## Required (already set)

### TAVILY_API_KEY
- Source: https://app.tavily.com
- Used for: web search (Rung 0 crawl) and `/extract` (Rungs 1-3
  user-link fetches)
- Free tier: 1000 credits/month. Covers a 100-friend demo.
- Status: **set in prod**

### ANTHROPIC_API_KEY
- Source: https://console.anthropic.com
- Used for: all Claude Opus synthesis calls
- Status: **set in prod**

### SUPABASE_SERVICE_ROLE_KEY
- Used for: mawd_instances reads/writes
- Status: **set in prod**

### GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
- Used for: Gmail OAuth at Rung 4
- Status: **set in prod**

## Optional (progressive enhancement)

The ladder works without any of these. Adding them gives richer
data on specific rungs.

### YOUTUBE_API_KEY (optional)
- Source: https://console.cloud.google.com/apis/library/youtube.googleapis.com
- Create a project, enable YouTube Data API v3, create an API key.
- Used for: richer YouTube channel fetch at Rung 1 or 2 (sub count,
  channel description, recent video titles, total views).
- Without it: Tavily `/extract` of the channel URL still works but
  returns less structured data.

### SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (optional)
- Source: https://developer.spotify.com/dashboard
- Create an app, copy Client ID and Client Secret (not Redirect URI).
- Used for: richer Spotify artist fetch at Rung 3 (followers, top
  tracks, genres, recent releases).
- Without it: Tavily `/extract` of the Spotify artist URL returns a
  usable summary including monthly listener count if present on the
  page.

## Setup flow for a fresh Vercel deploy

1. Copy keys into Vercel env vars for all three environments.
2. Trigger a redeploy (push a commit or click Redeploy in Vercel).
3. Verify with:

```
curl -sX POST https://fanded-mawd-chat.vercel.app/api/onboard-crawl \
  -H 'Content-Type: application/json' \
  -d '{"name":"Travis Atreo","userLinks":["https://open.spotify.com/artist/7yxELlULTDIIjlSOE0NwXe"]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('tier:',d.get('confidence_tier'));print('role:',d.get('inferred_role'))"
```

Expected: `tier: high`, `role: musician`.

## Cost estimate at 100-user ladder completion

- Tavily: ~5 calls per user (Rung 0 search + 3 rung fetches + 1 extract
  fallback) = 500 credits, well inside free tier.
- Anthropic: ~4 synthesis calls per user (Rung 0 + each rung that
  receives a link) = $0.10-0.15 per user depending on findings size.
  Full Path A = ~$10-15 for 100 users.
- YouTube/Spotify APIs: free tier daily quotas vastly exceed demo load.

## Known gaps (tomorrow)

- Instagram public scraping is blocked from Vercel IPs. Tavily helps for
  bio/follower count when the page is partially indexed, but is
  unreliable. Ladder offers "skip" at every rung.
- TikTok: same as Instagram.
- Spotify monthly listener count is not exposed via API. Tavily page
  extract sometimes pulls it from the rendered artist page.
