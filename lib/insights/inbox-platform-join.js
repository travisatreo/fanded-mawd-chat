// Inbox + Platform Join Insight Engine — STUB.
//
// Once the user has connected Gmail AND at least one public platform
// (Instagram, YouTube, Spotify, etc.), we have both sides of their
// identity graph and can produce insights neither side could produce
// alone. This is the high-value promise of MAWD: relationships live
// in the inbox, reach lives on platforms, and the interesting truths
// are at the join.
//
// This stub exists so the weekend work has a place to land.
//
// INTENDED API (not yet implemented):
//
//   import { computeInboxPlatformInsight } from '../lib/insights/inbox-platform-join.js';
//
//   const insight = await computeInboxPlatformInsight({
//     name: 'Travis Atreo',
//     inferred_role: 'musician',
//     inbox: {
//       threads: [...],          // recent Gmail threads (already scanned)
//       contacts: [...],         // inferred contact list with role tags
//       stale_loops: [...]       // threads where the user is the bottleneck
//     },
//     platforms: [
//       { source: 'instagram', recent_mentions: [...], top_commenters: [...] },
//       ...
//     ],
//     anthropic_key: process.env.ANTHROPIC_API_KEY
//   });
//   // -> { insight: "...", pattern_id: 'brand-commenter-in-inbox' }
//
// PLANNED PATTERNS (weekend build):
//   - "This brand that's been pitching you on IG has 3 unanswered emails from
//     their comms manager."
//   - "The producer you've DM'd 4 times this month hasn't opened your last
//     email."
//   - "Your top commenter on YouTube last quarter paid into Fanded Club
//     last year; they've gone quiet."
//   - "Your promoter in Manila hasn't heard from you since the Q3 show.
//     Your Spotify listeners there grew 40% since."
//
// These insights require joining two data sources that no single platform
// can see. This is the compounding-intelligence hook for MAWD.
//
// See docs/INSIGHT_ENGINE.md for the full plan.

export async function computeInboxPlatformInsight(_input) {
  // Not implemented. Weekend work.
  return null;
}

export function listPatterns() {
  return [];
}
