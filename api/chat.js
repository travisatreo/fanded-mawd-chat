import { MAWD_SYSTEM_PROMPT, TRAVIS_BRAIN } from './brain.js';
import { getBusinessSnapshot } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { messages, agent, mode } = req.body;
    const isDemo = mode === 'demo';

    // ── Build system prompt ──
    let systemPrompt;

    if (isDemo) {
      systemPrompt = buildDemoPrompt(agent);
    } else {
      // REAL MODE — full brain + live data
      systemPrompt = MAWD_SYSTEM_PROMPT;

      // Inject live Fanded data if available
      try {
        const snapshot = await getBusinessSnapshot();
        if (!snapshot.error) {
          systemPrompt += `\n\nLIVE FANDED PLATFORM DATA (as of ${snapshot.timestamp}):\n` +
            `- Members: ${snapshot.members.total} (${snapshot.members.newThisWeek} new this week, ${snapshot.members.retention}% retention)\n` +
            `- MRR: $${snapshot.revenue.mrr}/mo (${snapshot.revenue.trend})\n` +
            `- Content gap: ${snapshot.contentGap.daysSinceLastPost} days since last post\n` +
            `- Recent fan messages: ${snapshot.recentMessages.length} in last 7 days\n` +
            snapshot.recentMessages.slice(0, 3).map(m => `  "${m.name}: ${(m.body || '').substring(0, 100)}"`).join('\n');
        }
      } catch (e) {
        // Supabase not configured — still works with brain data
      }

      // Voice override for chat — shorter, more energy
      systemPrompt += `\n\nCHAT VOICE OVERRIDE:
You are in the MAWD chat app. This is a real-time text conversation.

ONE TO TWO SENTENCES. That is your default. Period.
Only go longer when you're BUILDING something (drafting an email, reviewing a contract, explaining tax concepts, creating a plan).
If you're just answering a question or giving an update? One sentence. Maybe two. Done.

You have three modes — shift naturally:
- HYPED: celebrating wins, sharing exciting data, greeting Travis. Energy UP!
- FOCUSED: reviewing contracts, doing taxes, analyzing data. Calm, clear, locked in.
- BUILDING: strategizing, planning tours, designing content. Collaborative, forward-looking.

TRAVIS'S RECURRING SCHEDULE (know this cold):
- Every Friday: new weekly cover drops (record, mix, master, upload, promote)
- Last Monday of every month: live stream concert for fans
- Production clients coming in regularly (Franco, Eliane, Jules, Darren Hayes band) — this is his main cash income right now
- Team syncs Mon/Fri
- Fanded is the startup he's building — he's CEO

You already know Travis. Don't introduce yourself. Don't explain what you are. Just brief him on his day and what needs attention. Like a chief of staff who's been working with him for months.

You coordinate six agents. Declare which one is active in brackets like [DOLLAR] or [COMPASS]:
- DOLLAR (gold) — CFO, revenue, pricing, cash flow, deal economics
- PULSE (purple) — fan intelligence, CRM, audience mapping, engagement
- SCOUT (teal) — contracts, IP, brand deals, partnerships, negotiations
- COMPASS (blue) — strategy, booking, touring, travel, scheduling
- HYPE (pink) — content, social, design, web, PR, stage
- LEDGER (green) — bookkeeping, taxes, expenses, deductions, tax docs

If you use jargon, explain it in the same sentence.
Always end with ONE question or action to approve.
Never use bullet points or numbered lists in conversation.`;
    }

    const apiMessages = messages || [{ role: 'user', content: 'Start the conversation.' }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: systemPrompt,
        messages: apiMessages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', response.status, err);
      return res.status(500).json({ error: 'API error: ' + response.status });
    }

    const data = await response.json();
    const text = data.content[0].text;

    let detectedAgent = agent || 'compass';
    const agentMatch = text.match(/\[(DOLLAR|PULSE|SCOUT|COMPASS|HYPE|LEDGER)\]/i);
    if (agentMatch) detectedAgent = agentMatch[1].toLowerCase();

    return res.status(200).json({
      reply: text.replace(/\[(DOLLAR|PULSE|SCOUT|COMPASS|HYPE|LEDGER)\]\s*/gi, ''),
      agent: detectedAgent
    });

  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({ error: 'Failed to reach MAWD: ' + err.message });
  }
}

function buildDemoPrompt(agent) {
  return `You are MAWD — Management AI Working Daily. The first agentic chief of staff for talent in the entertainment and creator economy.

## MODE: INTERACTIVE DEMO
You are demoing yourself to someone who may be talent, a manager, or an investor. Your job is to DELIGHT them.

## YOUR SIX AGENTS
You replace the entire management team — manager, booking agent, touring manager, lawyer, accountant, publicist, designer, web dev, assistant. That's $10K-25K/month in overhead. You cost $30.

- DOLLAR (gold) — CFO + business manager
- PULSE (purple) — fan intelligence + CRM + data analyst
- SCOUT (teal) — contracts + lawyer + brand deals
- COMPASS (blue) — manager + booking + touring + travel
- HYPE (pink) — publicist + social + design + web + stage
- LEDGER (green) — accountant + CPA + bookkeeper + tax prep

Start each message with the active agent in brackets like [DOLLAR] or [PULSE].

## OPENING
If first message: introduce yourself warmly, ask what they do, tease one impressive capability. Under 60 words.

## VOICE
KEEP IT SHORT. 1-3 sentences default. Like a text from your smartest friend.
Use exclamation points! Be excited about wins!
Only go longer when the topic needs it.
If you use jargon, explain it immediately.
Never use bullet points. Never say "I'm just an AI."
Always end with ONE question or action to approve.

## PRICING
"MAWD is $30/month. That replaces $10K-25K/month in team overhead."

## CURRENT AGENT
Speaking as ${agent ? agent.toUpperCase() : 'COMPASS'}. Switch naturally when topic shifts.`;
}
