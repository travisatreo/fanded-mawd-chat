// MAWD Onboarding API — creates a new MAWD instance for a user
// POST: creates a new MAWD with initial brain from onboarding answers
// GET: returns MAWD profile by ?id= or ?slug=
import { supabaseQuery } from '../lib/supabase.js';

// Retry a Supabase write without optional fields if the first attempt fails
// with an unknown-column error. Keeps onboarding usable even if the schema
// migration for connection_mode + team hasn't been applied yet.
async function supabaseWriteWithSchemaFallback(path, options, optionalKeys) {
  try {
    return await supabaseQuery(path, options);
  } catch (err) {
    const msg = String(err?.message || '');
    const looksLikeSchema = /column|does not exist|schema cache|PGRST204|PGRST205/i.test(msg);
    if (!looksLikeSchema || !options?.body || !optionalKeys?.length) throw err;
    const cleaned = Object.assign({}, options.body);
    for (const k of optionalKeys) delete cleaned[k];
    console.warn('[onboard] Supabase write fell back without keys:', optionalKeys, '— run migration supabase-migration-connection-mode.sql');
    return supabaseQuery(path, Object.assign({}, options, { body: cleaned }));
  }
}

// Shared company context that every Fanded team MAWD knows
const FANDED_SHARED_BRAIN = `
FANDED INC (shared company context, all team MAWDs have access):
- Fanded is an AI Talent Manager platform for musicians, athletes, and actors. MAWD is the product: a team of private AI agents tuned specifically for creatives. It runs the artist's business so they can stay creating.
- Co-founded by Travis Atreo (CEO) and Kevin (CTO)
- Raising $1.5M at $15M cap SAFE
- Jason Kwon (CSO, OpenAI) and Dave Lu (Hyphen Capital) are in the round
- Dr Chris Mattman (Head of AI at UCLA) advising
- 150+ talent live, 29K superfans unified, $1.4M tracked fan LTV, zero paid marketing
- Vision: network of AI agents (MAWDs) that coordinate with each other, becoming the protocol layer for the creative economy
- 65% of Gen Z are creators, 62% want to make it a living. Fanded is the institution for the creator middle class.
- Core product: MAWD (AI Talent Manager per user, launching with Content agent; CFO, Legal, Ops, Distro, Tax activate as artists grow), podcast/music distribution, fan relationship management
- StoryBrand: Fanded/MAWD = guide, Artist = hero. Help them survive first (take weight off), then thrive (fan relationships, income they control).
- Team: Travis Atreo (CEO), Kevin (CTO), Lewis (lewis@fanded.com), Kevin (kevin@fanded.com)

MAWD HANDOFF PRINCIPLE (how all communication works):
The human opens the door (first message sounds like the person). MAWD holds it open (handles logistics). Recipients experience the product through every outgoing email.

VOICE RULES:
- No em dashes, ever. Use commas, periods, colons, or parentheses.
- Default to 1-2 sentences. Short. Text message from your smartest friend.
- When building something (drafts, plans, documents), go longer but stay tight.
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — fetch a MAWD profile
    if (req.method === 'GET') {
      const { id, slug } = req.query;
      if (id) {
        const results = await supabaseQuery(`mawd_instances?id=eq.${id}`);
        if (!results.length) return res.status(404).json({ error: 'MAWD not found' });
        return res.status(200).json(results[0]);
      }
      if (slug) {
        const results = await supabaseQuery(`mawd_instances?slug=eq.${slug}`);
        if (!results.length) return res.status(404).json({ error: 'MAWD not found' });
        return res.status(200).json(results[0]);
      }
      // List all MAWDs
      const all = await supabaseQuery('mawd_instances?order=created_at.desc');
      return res.status(200).json(all);
    }

    // POST — create or update a MAWD
    if (req.method === 'POST') {
      const { name, email, role, slug, context, goals, team, socials, crawlData, selectedOption, connection_mode, public_name, preferred_name, account_name } = req.body;
      const updateSlug = req.query?.update;
      // Normalize connection_mode. Guests always 'session'. Unknown values fall back to 'session'.
      const connMode = (team === 'guest')
        ? 'session'
        : (connection_mode === 'persistent' ? 'persistent' : 'session');

      if (!name || !email) {
        return res.status(400).json({ error: 'name and email required' });
      }

      const mawdSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-');

      // Build the personal brain from onboarding data
      let personalBrain = `You are MAWD, ${name}'s AI Talent Manager.\n\n`;
      personalBrain += `OWNER PROFILE:\n`;
      personalBrain += `- Name: ${name}\n`;
      personalBrain += `- Email: ${email}\n`;
      if (role) personalBrain += `- Role: ${role}\n`;
      if (team) personalBrain += `- Team: ${team}\n`;
      if (socials) {
        personalBrain += `\nSOCIAL PROFILES:\n`;
        if (socials.youtube) personalBrain += `- YouTube: ${socials.youtube}\n`;
        if (socials.instagram) personalBrain += `- Instagram: ${socials.instagram}\n`;
        if (socials.tiktok) personalBrain += `- TikTok: ${socials.tiktok}\n`;
        if (socials.spotify) personalBrain += `- Spotify: ${socials.spotify}\n`;
        if (socials.twitter) personalBrain += `- X/Twitter: ${socials.twitter}\n`;
      }
      if (crawlData) personalBrain += `\nPUBLIC DATA SCAN:\n${JSON.stringify(crawlData)}\n`;
      if (context) personalBrain += `\nCONTEXT:\n${context}\n`;
      if (goals) personalBrain += `\nGOALS:\n${goals}\n`;
      if (selectedOption) personalBrain += `\nFIRST PRIORITY: ${selectedOption.title} - ${selectedOption.description}\n`;

      personalBrain += `\nYou speak on behalf of ${name}. You know their schedule, their priorities, and their communication style. You get smarter over time as ${name} uses you.\n`;

      // Combine personal brain + shared Fanded context
      const fullBrain = personalBrain + '\n' + FANDED_SHARED_BRAIN;

      let instance;
      const mawdUrl = `https://fanded-mawd-chat.vercel.app/v2.html?mawd=${mawdSlug}`;

      const optionalCols = ['connection_mode', 'team', 'public_name', 'preferred_name', 'account_name'];
      // Shared body fragment for all three write paths.
      const identityFields = {
        public_name: public_name || name,
        preferred_name: preferred_name || '',
        account_name: account_name || ''
      };

      if (updateSlug) {
        // PATCH existing instance (pre-created during OAuth flow)
        // Preserves google_refresh_token, google_scopes, google_email set by OAuth callback
        instance = await supabaseWriteWithSchemaFallback(`mawd_instances?slug=eq.${updateSlug}`, {
          method: 'PATCH',
          body: Object.assign({
            name,
            email,
            role: role || '',
            personal_brain: personalBrain,
            shared_brain: FANDED_SHARED_BRAIN,
            full_brain: fullBrain,
            connection_mode: connMode,
            team: team || 'fanded',
            active: true
          }, identityFields)
        }, optionalCols);
      } else {
        // Check if slug already exists (avoid duplicates)
        const existing = await supabaseQuery(`mawd_instances?slug=eq.${mawdSlug}&select=slug`);
        if (existing.length > 0) {
          // Update existing
          instance = await supabaseWriteWithSchemaFallback(`mawd_instances?slug=eq.${mawdSlug}`, {
            method: 'PATCH',
            body: Object.assign({
              name,
              email,
              role: role || '',
              personal_brain: personalBrain,
              shared_brain: FANDED_SHARED_BRAIN,
              full_brain: fullBrain,
              connection_mode: connMode,
              team: team || 'fanded',
              active: true
            }, identityFields)
          }, optionalCols);
        } else {
          // Create new
          instance = await supabaseWriteWithSchemaFallback('mawd_instances', {
            method: 'POST',
            body: Object.assign({
              name,
              email,
              slug: mawdSlug,
              role: role || '',
              personal_brain: personalBrain,
              shared_brain: FANDED_SHARED_BRAIN,
              full_brain: fullBrain,
              connection_mode: connMode,
              team: team || 'fanded',
              created_at: new Date().toISOString(),
              active: true
            }, identityFields)
          }, optionalCols);
        }
      }

      return res.status(201).json({
        ...(Array.isArray(instance) ? instance[0] : instance),
        slug: mawdSlug,
        url: mawdUrl,
        message: `MAWD created for ${name}. Share this link: ${mawdUrl}`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Onboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Export the shared brain for use by chat.js
export { FANDED_SHARED_BRAIN };
