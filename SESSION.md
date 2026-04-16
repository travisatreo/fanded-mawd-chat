# Path A Build Session — 2026-04-16

Building the 5-rung trust ladder onboarding. This log captures every
implementation decision made during the autonomous overnight build.

## Starting state

- Rung 0 (name + Tavily crawl + dossier with confidence_tier) shipped.
- Second-pass crawl from a single `userLinks[0]` already works and flips
  Travis Atreo from tier=medium to tier=high when his Spotify URL is
  pasted.
- Server endpoint `/api/onboard-crawl` already handles `userLinks: string[]`
  via `fetchUserLink()` (Tavily extract primary, direct GET fallback).
- Deployed: `cca0e87` on main.
- Env: TAVILY_API_KEY ✓, ANTHROPIC_API_KEY ✓. No YouTube/Spotify keys yet.

The ladder is essentially Rung 0 (existing) + three sequenced paste-link
asks (reusing the second-pass plumbing) + cross-reference insight between
Rung 1 and Rung 2 + Gmail copy update at Rung 4. Most infrastructure
exists — the work is state machine, UX pacing, and the insight engine.

## Architecture decisions (made tonight)

### Decision 1: Reuse existing second-pass plumbing
Instead of building a new API or new client flow, call the existing
`POST /api/onboard-crawl { name, userLinks }` at each rung, passing
the accumulated user-provided URLs array. The server already merges
user-vouched findings into synthesis. The rung concept lives on the
client.

**Why:** proven code path, no new function count pressure, Claude
synthesis already understands USER-VOUCHED findings.

### Decision 2: One ask screen, one refresh screen, one dossier screen
The ladder reuses `s-paste-link` (renamed to `s-rung-ask`), `s-refresh`,
and `s-dossier`. Client state `state.rung` (1-3) drives copy, placeholder,
and next-step behavior. New screens cost complexity; reusing keeps the
CSS/animation surface stable.

### Decision 3: Platform-specific fetchers are progressive enhancement
`fetchUserLink()` already works via Tavily /extract for any URL. For
YouTube and Spotify, if the respective API keys are present, use the
richer API fetch first and fall back to Tavily. No key = Tavily only.
Ship without YouTube/Spotify keys; both can be added post-deploy.

**Why:** user said "do not block the build on missing API keys." The
Tavily path has already been validated for Travis's Spotify URL.

### Decision 4: Cross-reference insight runs server-side at Rung 2
When the request has >= 2 user-vouched findings, the synthesis prompt
adds the 7-pattern cross-reference template + Claude fallback. The
dossier output embeds the insight as a second paragraph. No separate
endpoint.

**Why:** the insight needs access to both platforms' text anyway, and
the synthesis step is already paying for a Claude call. Adding a
separate endpoint would push us closer to the 12-function cap and
double-pay for Claude.

### Decision 5: No feature flag on the ladder
The ladder replaces the existing post-dossier → Gmail transition. Skip
at every rung means any failure still lands the user at Gmail. The
existing tier-aware flow (Tier-1 high-confidence users get skip-to-Gmail
via Rung 1 skip; Tier-3 low users get routed through fallback) is
preserved by the skip logic. Ladder is default-on.

**Why:** simpler to ship, every failure has a fallback path, no dead
code branches. If ladder breaks I'll revert, not toggle.

### Decision 6: Progress indicator is a 5-dot sequence top-center
Dots 0-4 correspond to Rungs 0-4. Current rung is gold-filled, past
rungs are dim-filled, future rungs are hollow. Survives existing visual
language (the onboarding already uses dot progress).

## Risks flagged for tomorrow

1. **Instagram and TikTok scraping is brittle.** Both aggressively block
   serverless IP ranges. Tavily `/extract` works for some but not all.
   When it fails, the user sees an honest error and a "try another
   platform or skip" affordance.
2. **Spotify monthly listener count is not in the public API.** Client
   credentials flow gives followers and top tracks only. Tavily extract
   of the artist page can sometimes return monthly listeners as a
   snippet. Good enough for demo.
3. **Cross-reference insight quality depends on how much structured data
   we actually have.** If Tavily extract returns only a bio blurb, the
   7 patterns can't fire and the Claude fallback produces generic
   insight. This is acceptable for v1.
4. **The ladder adds 3 extra screens before Gmail.** Users who bail mid-
   ladder get less data than users who complete all 5. Acceptable since
   Rung 0 alone is already better than what we had last week.

## Build progression

(filled in as I go)
