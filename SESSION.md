# Session Log — Rollback + Persona + Insight Scaffolding

Updated: 2026-04-16 late night. Rollback + persona encoding + insight
engine architecture staging. Shipped to main.

## Status of the live URL

**https://fanded-mawd-chat.vercel.app/** — stable.

Onboarding flow for tomorrow's demo:

1. Name / stage name / handle (Screen 1)
2. Live public crawl (Tavily + Wikipedia + handle probes + DDG)
3. Dossier presentation with confidence tier
4. Optional preferred-name step (only shown when input is handle-like)
5. Gmail connect with minimal copy
6. Inbox scan with role-adapted status messages
7. Optional handles deepening (Screen 6)
8. Main canvas with role-adapted sidebar

All Settings modal affordances (Gmail mode switch, disconnect, reset,
guest session, change role) still work. Tavily still primary search.
Confidence tiers still drive dossier UI. Multi-identity data model
(public_name / preferred_name / account_name) still wired.

## What tonight did

### Part 1 — Rollback

Reverted `onboard.html` and `api/onboard-crawl.js` to commit
`cca0e87` ("tier-aware dossier UI + second-pass crawl from user link"),
the last known-stable state before Path A ladder work began.

Removed: 5-rung ladder UI, rung progress dots, new s-rung-ask screen,
cross-reference insight embedded in synthesis, YouTube/Spotify
platform-specific fetchers (they still exist but are unreachable
because the rung UI that called them is gone).

Preserved: all backend keepers (Tavily crawl, confidence classifier,
stage-name data model, Settings modal, guest mode, Gmail session/
persistent modes, Supabase migration, inbox scan).

Path A WIP is preserved on `feature/path-a-wip` branch for weekend
resumption. The file-level diff needed to bring Path A back is a
clean cherry-pick.

Commits:
- `<rollback commit sha>` — revert onboard.html + onboard-crawl.js

### Part 2 — Persona encoding with prompt caching

New files:
- `system/mawd-persona.md` — single source of truth for MAWD voice,
  tone, product philosophy. Includes Information Parity, Handoff
  Principle, Revenue Before Admin, Strategy First Thrive Energy,
  StoryBrand role. Includes mechanical voice rules (no em dashes, no
  AI slop, no filler phrases, no hedging) and character rules.
- `lib/persona.js` — loader module. Reads the persona.md file once
  at cold start, exposes `personaSystemBlock()` returning an Anthropic
  system-blocks array with `cache_control: ephemeral` set on the
  persona block. Endpoint-specific context appends as additional
  (uncached) blocks.

Wired into every Claude call that generates user-facing copy:
- `api/onboard-crawl.js::synthesizeDossier` (dossier generation)
- `api/chat.js` main chat loop (system prompt + persona)
- `api/chat.js` tool-use retry loop (same cached persona)
- `api/chat.js` inbox-scan synthesis (persona-only, no other system)

Expected benefit:
- Voice consistency across all outputs without re-writing rules in
  every prompt.
- Token cost savings on high-volume calls. Persona is ~2300 words
  (~3000 tokens). Cached hit on 2nd+ call in a 5-minute window pays
  90% off that block.
- Single place to version and update voice. Edit the .md, every call
  picks it up on next cold start.

Content source note: the original prompt had a placeholder
"[paste the manifesto and tone rules section from the earlier prompt
here]" but the earlier prompt was cut off before the actual contents.
I drafted persona.md from patterns I've observed across this entire
session (no em dashes, Information Parity, StoryBrand, revenue-first,
handoff principle, stage-name handling, agent architecture, etc).
**Travis should review and edit when he's back.**

### Part 3 — Insight engine architecture (scaffolds only, no implementation)

New files:
- `docs/INSIGHT_ENGINE.md` — full architecture doc, two engines,
  pattern taxonomy, data contracts, weekend build checklist, success
  metric.
- `lib/insights/cross-platform.js` — stub orchestrator for the
  onboarding-time insight engine.
- `lib/insights/inbox-platform-join.js` — stub orchestrator for the
  post-Gmail insight engine (the high-value one).
- `lib/insights/patterns/.gitkeep` — directory reserved for the
  per-pattern modules that get built this weekend.

Trade-off flagged: stubs live in `lib/insights/` not `/api/insights/`
because we are at the Vercel Hobby 12-function cap. Stubs are
library modules, not serverless routes. The existing crawl + chat
endpoints will import them directly. If we upgrade Vercel later we
can re-home them.

No functional change from these scaffolds yet. The current
functional cross-reference insight (7 patterns) still lives inline
in `api/onboard-crawl.js::crossReferenceInsight` (in the
`feature/path-a-wip` branch). Weekend task: migrate those 7 patterns
into `lib/insights/patterns/*.js` and extend to 17 total.

## Known issues carried forward

1. **Tavily is primary, but still goes thin for people without
   Wikipedia articles.** Travis Atreo himself falls into this bucket.
   The paste-link Tier-2 flow works (confirmed earlier via Spotify
   URL). Your first demo-friend should probably be someone with a
   real Wikipedia article.
2. **Spotify API credentials not set in Vercel.** Without them, the
   paste-link flow for Spotify URLs falls back to Tavily /extract.
   Works but doesn't surface monthly listener counts. See
   `SETUP_PATH_A.md` for provisioning (still relevant).
3. **`api/google-auth.js` has uncommitted changes.** Travis's
   `brain_gmail_accounts` work is in the working tree. Not touched
   by any of tonight's commits. When he's ready to land that, it's
   a clean commit on its own.
4. **Path A rung ladder had bugs.** Preserved on
   `feature/path-a-wip`. Do NOT attempt to merge straight back; the
   bugs (YouTube fetcher state, duplicate handles ask,
   handle-collection-screen-after-Gmail) need fixes identified in
   previous SESSION.md entries before the ladder ships.

## What to check tomorrow morning before driving

1. Open https://fanded-mawd-chat.vercel.app/ in a fresh incognito.
2. Type "Travis Atreo" in the name field.
3. Confirm dossier appears with sources ("wikipedia, github, ...").
4. Confirm tap-through to Gmail connect screen.
5. (Optional) Confirm OAuth round-trip + inbox scan.

If any of those fail, send me a screenshot and I'll fix same-session.

## What's queued for the weekend

1. **Review manifesto draft.** Edit `system/mawd-persona.md` to your
   taste. It's ~2300 words and covers voice rules, product philosophy,
   and vocabulary. Anything you change flows to every Claude call.
2. **Decide Path A fate.** Three options: (a) resume ladder with bug
   fixes on `feature/path-a-wip`, (b) redesign a simpler ladder
   (e.g. 1-rung "drop me one link" variant), (c) stay on current
   tier-aware single-paste-link flow and invest in the insight
   engine instead.
3. **Build out `lib/insights/patterns/`.** Per
   `docs/INSIGHT_ENGINE.md`, migrate the 7 inline patterns, add 4
   more cross-platform patterns, add 6 inbox-platform-join patterns.
   This is the thing that makes investors lean in.
4. **Provision `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`** on
   Vercel for the musician demo path.
5. **(Optional) `/plan-ceo-review` + `/design-consultation` +
   `/design-review` + `/qa`** — you asked for these in the pivot
   message. I proposed running them this weekend against the
   stabilized state, not blocking tonight's demo. Ping me to kick
   them off when you're back and I'll route each one properly
   (CEO review is interactive, the others can run semi-autonomously
   in the background).
