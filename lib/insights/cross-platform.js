// Cross-Platform Insight Engine — STUB.
//
// Given two or more platform datasets for a single user (e.g. Instagram
// follower count + YouTube subscriber count + Spotify top tracks),
// produce a short, non-obvious observation a creator would want to know
// about their own presence.
//
// This stub exists so the weekend insight-engine work has a place to
// land. Real implementation lives in lib/insights/patterns/*.js and
// this file orchestrates them.
//
// INTENDED API (not yet implemented):
//
//   import { computeCrossPlatformInsight } from '../lib/insights/cross-platform.js';
//
//   const insight = await computeCrossPlatformInsight({
//     name: 'Travis Atreo',
//     inferred_role: 'musician',
//     platforms: [
//       { source: 'instagram', followers: 45000, bio: '...', recent_posts: [...] },
//       { source: 'youtube',   subscribers: 316000, channel_desc: '...', recent_videos: [...] },
//       { source: 'spotify',   followers: 48000, monthly_listeners: 344000, top_tracks: [...] }
//     ],
//     anthropic_key: process.env.ANTHROPIC_API_KEY
//   });
//   // -> { insight: "Your center of gravity is...", pattern_id: 'platform-dominance' }
//
// RESPONSIBILITIES (planned):
//   1. Normalize platform stats into a common shape.
//   2. Run each pattern in lib/insights/patterns/ and collect any that fire.
//   3. If multiple fire, rank by specificity and pick the winner.
//   4. If none fire, fall back to an open-ended Claude synthesis using
//      the persona as the system block.
//   5. Return {insight: string, pattern_id: string, confidence: 'high'|'medium'}.
//
// See docs/INSIGHT_ENGINE.md for the full pattern taxonomy and weekend
// build plan.

export async function computeCrossPlatformInsight(_input) {
  // Not implemented. The current functional cross-reference insight
  // lives inline in api/onboard-crawl.js. This module will replace it
  // during the weekend rebuild.
  return null;
}

export function listPatterns() {
  // Weekend task: dynamically import lib/insights/patterns/*.js and
  // surface their metadata. For now the patterns live inline in
  // api/onboard-crawl.js::crossReferenceInsight().
  return [];
}
