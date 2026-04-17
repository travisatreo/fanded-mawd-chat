# MAWD Insight Engine — Architecture & Build Plan

This doc is the plan for the insight layer that makes MAWD feel
intelligent, not just helpful. It's the thing an investor leans in for,
and it's the thing a creator will pay for even if every other feature
failed.

## What an "insight" is

A short, non-obvious observation about the user's own career that:

1. **Is grounded in real data** they gave or MAWD pulled. Never invented.
2. **They don't already know.** If the user's reaction is "yeah, obviously,"
   it failed. If the reaction is "wait, how did you know that?" it passed.
3. **Points to an action.** Good insights imply a next move. Either
   MAWD offers to do the action (draft, reach out, schedule), or the
   insight ends with a question that's really a decision.

Examples of real insights (from the patterns we've shipped and planned):

- "Your center of gravity is YouTube. That's your main room. The others
  are extensions." (Pattern: platform-dominance)
- "Your Instagram and YouTube are telling the same story with different
  tools. The consistency is real." (Pattern: theme-overlap)
- "This brand that's been pitching you on IG has 3 unanswered emails
  from their comms manager." (Planned pattern: inbox-platform join)
- "Your promoter in Manila hasn't heard from you since Q3. Your Spotify
  listeners there grew 40% since." (Planned pattern: geography + silence)

Examples of NOT-insights (avoid):

- "You have 45K followers on Instagram." (the user knows)
- "You should engage more with your audience." (vague, no grounding)
- "Your content seems to be performing well." (hedge + generic)

## Engine topology

Two engines, shipping in order:

### 1. Cross-Platform Insight Engine — `lib/insights/cross-platform.js`

**Status:** stub shipped. Functional v1 lives inline in
`api/onboard-crawl.js::crossReferenceInsight()`. Weekend task is to
migrate + expand.

**When it runs:** during onboarding, once the user has connected 2+
public platforms (Rung 1 and Rung 2 of Path A ladder).

**Data sources:** platform snippets returned by Tavily /extract plus
platform-specific API enrichment (YouTube Data API, Spotify client
credentials).

**Output shape:**
```
{
  insight: "Your center of gravity is YouTube. That's your main room...",
  pattern_id: "platform-dominance",
  confidence: "high"
}
```

### 2. Inbox + Platform Join Engine — `lib/insights/inbox-platform-join.js`

**Status:** stub only. Weekend build.

**When it runs:** after Gmail OAuth + inbox scan completes, on the main
canvas. Refreshed nightly via cron.

**Data sources:** inbox scan results (threads, contacts, stale loops)
joined with the platform data from onboarding + any deepening handles.

**Output shape:** same as above, plus optional `draftTarget` for
immediate action.

This is the higher-value engine. It's what makes MAWD feel like a
talent manager and not a Linktree.

## Pattern taxonomy (planned, in build order)

### Shipped (in `api/onboard-crawl.js::crossReferenceInsight`, migrate to patterns/ this weekend)

1. **audience-asymmetry** — follower count ratio >= 3x between two platforms
2. **output-asymmetry** — post/video/track count ratio >= 3x
3. **format-fit** — short-form vs long-form performance divergence
4. **platform-dominance** — single platform clearly the "home"
5. **theme-overlap** — same vocabulary across platforms (consistency read)
6. **voice-divergence** — different tone across platforms (audience split)
7. **scarce-output** — audience without recent output (leverage unused)

### Weekend targets for Cross-Platform engine

8. **growth-rate-asymmetry** — one platform growing meaningfully faster
   than another (requires historical data or last-post timestamps)
9. **engagement-quality-divergence** — higher engagement rate on smaller
   platform (requires engagement data via platform APIs)
10. **platform-momentum** — recent posts on one platform showing strong
    traction vs stagnation elsewhere
11. **geographic-divergence** — top cities/countries differ meaningfully
    between platforms (IG + Spotify have this data)

### Weekend targets for Inbox-Platform join engine

12. **brand-commenter-in-inbox** — a brand DMing or commenting on posts
    also has unanswered email threads from their corporate/comms team
13. **platform-ghost-email-silent** — person user has DM'd multiple
    times hasn't opened recent emails from them
14. **paying-fan-went-quiet** — top commenter/supporter on a platform
    also paid into Fanded/Patreon historically and hasn't been reached
    recently
15. **geography-silence-growth** — a promoter/contact in city X hasn't
    heard from user in N months, but platform reach in city X grew M%
    in the same window (direct income opportunity)
16. **repeat-payer-ghost** — someone who paid multiple times is not
    in any active thread
17. **meeting-without-context** — calendar event exists with a person
    whose inbox history contradicts the meeting's stated purpose

Patterns 14, 15, 16 are the ones investors should see demo'd. They're
the "MAWD knows what my human manager would know, but MAWD is three
steps ahead because it has both sides of the graph."

## Data contract per pattern

Each pattern module in `lib/insights/patterns/` exports:

```js
export const id = 'platform-dominance';
export const version = 1;
export const description = 'One platform is clearly the user's home room';

// Return { insight, confidence } if the pattern fires, else null.
export function fire(normalizedInput) { ... }
```

The orchestrator in `cross-platform.js` and `inbox-platform-join.js`
runs all patterns, ranks any that fire by confidence + specificity,
and returns the winner.

## Persona binding

Every Claude call that generates insight prose inherits the system
block from `lib/persona.js`:

```js
import { personaSystemBlock } from '../lib/persona.js';
// ...
body: JSON.stringify({
  system: [...personaSystemBlock(), { type:'text', text: endpointContext }],
  messages: [{ role:'user', content: insightPrompt }]
})
```

This keeps voice consistent with the rest of MAWD without re-pasting
the rules into every prompt.

## Vercel function count (reminder)

We're at the 12-function Hobby cap. The insight engine MUST live in
`lib/insights/` not `/api/insights/` until we consolidate or upgrade.
The existing crawl + chat endpoints call the insight modules directly.

## Weekend build checklist

- [ ] Move the 7 shipped patterns out of `api/onboard-crawl.js` into
      `lib/insights/patterns/` files, one per pattern, with the
      standard `id / version / description / fire()` export shape.
- [ ] Wire `computeCrossPlatformInsight()` orchestrator to read the
      patterns directory, run all, rank, return the winner.
- [ ] Add patterns 8-11 (growth rate, engagement quality, momentum,
      geography).
- [ ] Build inbox-platform-join orchestrator and patterns 12-17.
- [ ] Thread insight output into main canvas as its own card type
      (distinct from metric cards and draft cards).
- [ ] Nightly cron job (`/api/scheduled`) re-runs inbox-platform-join
      for each active user and pushes new insights to their canvas.

## Success metric

During an investor demo, when the user lands on the canvas after
connecting Gmail + one platform, they see at least one insight that
makes them pause and say "wait, how did you know that?" If zero
insights fire, we fall back to an honest "I'm still getting to know
your mix" state, but the goal is >= 1 insight for any user with real
activity.
