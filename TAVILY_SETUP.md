# TAVILY_API_KEY — how to provision

MAWD's onboarding crawl uses Tavily as its primary web search source. Without
a key, the crawl falls back to Wikipedia + direct handle probes only (current
behavior), which produces thin dossiers for anyone without a Wikipedia article.

## Why Tavily

Tavily is purpose-built for LLM agent crawls on serverless. Unlike DuckDuckGo
HTML scraping (blocked on Vercel IP ranges) or SerpAPI (expensive from day
one), Tavily:

- Works on Vercel serverless without IP blocking
- Returns ranked, cleaned, LLM-ready content in one POST (no separate scrape)
- Free tier: 1000 credits per month, covers a 100-friend demo easily
- `include_domains` biases toward Wikipedia, Spotify, IMDb, LinkedIn, press

## Setup (5 minutes)

1. Visit https://app.tavily.com and sign up (no credit card required for the
   free tier).
2. Copy your API key from the dashboard.
3. Add it to Vercel:

   - https://vercel.com/dashboard → fanded-mawd-chat → Settings → Environment
     Variables
   - Name: `TAVILY_API_KEY`
   - Value: paste key
   - Environment: Production, Preview, Development (all three)
   - Save
4. Trigger a redeploy (push any commit, or click "Redeploy" in Vercel).

5. Verify: curl the crawl endpoint with a known public figure:

   ```
   curl -s -X POST https://fanded-mawd-chat.vercel.app/api/onboard-crawl \
     -H "Content-Type: application/json" \
     -d '{"name":"Travis Atreo"}' | head -30
   ```

   You should see findings including `wikipedia`, `spotify`, or press sources
   (not just a single github handle). If the dossier still mentions only
   github, check the Vercel function logs for `Tavily skipped: ...`.

## Cost at scale

- 100-friend demo: **free** (well inside 1000-credit monthly allowance)
- ~10k queries/month post-launch: **~$30-78/mo** on Tavily Project plan
- Add SerpAPI fallback only if you see gaps in top-tier public-figure
  dossiers after user feedback

## Without the key

The crawl still works, just thinner:

- Wikipedia REST API: hits for anyone with a Wikipedia article
- Handle probes: LinkedIn, Instagram, Twitter, YouTube, TikTok, GitHub
- DuckDuckGo HTML: usually blocked on Vercel, ~0 hits

Anyone without a Wikipedia article gets the "drop me a link" fallback copy.
Fine for testing. Not fine for the 10-friend demo.
