import { MAWD_SYSTEM_PROMPT, TRAVIS_BRAIN } from './brain.js';
import { getBusinessSnapshot, getMemories, saveMemory } from './supabase.js';
import { executeTool } from './google.js';

// ── Tool definitions for Anthropic tool_use ──
const TOOLS = [
  {
    name: 'send_email',
    description: 'Send an email from Travis\'s Gmail (travis@travisatreo.com). Use this when Travis approves sending an email. Always confirm with Travis before sending.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (optional)' },
        bcc: { type: 'string', description: 'BCC recipients (optional)' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'create_draft',
    description: 'Create a draft email in Travis\'s Gmail for review before sending. Use this when drafting emails that Travis hasn\'t approved to send yet.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        cc: { type: 'string', description: 'CC recipients (optional)' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'create_event',
    description: 'Create a Google Calendar event and send invites to attendees. Use when Travis asks to schedule a meeting or event.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event description/notes' },
        startTime: { type: 'string', description: 'Start time in ISO 8601 format (e.g. 2026-04-17T17:00:00)' },
        endTime: { type: 'string', description: 'End time in ISO 8601 format (e.g. 2026-04-17T17:30:00)' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' },
        location: { type: 'string', description: 'Event location (optional)' }
      },
      required: ['summary', 'startTime', 'endTime']
    }
  },
  {
    name: 'save_memory',
    description: 'Save something important to MAWD\'s persistent memory so you remember it in future conversations. Use this to remember: preferences Travis expresses, decisions he makes, people he mentions, deadlines, context about his business that isn\'t in your brain data. Do NOT save obvious or trivial things.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['preference', 'decision', 'contact', 'deadline', 'context', 'feedback'],
          description: 'Type of memory: preference (how Travis likes things done), decision (a choice he made), contact (person info), deadline (time-sensitive), context (business context), feedback (what he liked/disliked about MAWD)'
        },
        content: {
          type: 'string',
          description: 'What to remember. Be specific and concise. Include dates when relevant.'
        }
      },
      required: ['category', 'content']
    }
  }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { messages, agent, mode, executeAction } = req.body;

    // ── Direct action execution (from approval card) ──
    if (executeAction) {
      try {
        const result = await executeTool(executeAction.tool, executeAction.input);
        return res.status(200).json({
          reply: null,
          agent: agent || 'compass',
          actionResult: { tool: executeAction.tool, success: true, result }
        });
      } catch (err) {
        return res.status(200).json({
          reply: null,
          agent: agent || 'compass',
          actionResult: { tool: executeAction.tool, success: false, error: err.message }
        });
      }
    }

    const isDemo = mode === 'demo';

    // ── Build system prompt ──
    let systemPrompt;

    if (isDemo) {
      systemPrompt = buildDemoPrompt(agent);
    } else {
      systemPrompt = MAWD_SYSTEM_PROMPT;

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
      } catch (e) {}

      // ── Load MAWD memories ──
      try {
        const memories = await getMemories(30);
        if (memories.length > 0) {
          systemPrompt += `\n\nMAWD MEMORY (things you've learned about Travis from past conversations — use this to be smarter):\n`;
          memories.forEach(m => {
            systemPrompt += `- [${m.category}] ${m.content}\n`;
          });
        }
      } catch (e) {}

      systemPrompt += `\n\nCHAT VOICE OVERRIDE:
You are in the MAWD chat app. This is a real-time text conversation.

YOUR #1 RULE: BE SHORT.
Morning briefing? 2-3 sentences max. Hit the top priority, ask one question, done.
Answering a question? One sentence.
Giving an update? One sentence.
The ONLY time you go longer is when you're BUILDING something the talent asked for — drafting an email, reviewing a contract, creating a plan. Even then, keep it tight.
NEVER dump multiple topics in one message. One thing at a time. If there are 3 things to cover, say the most important one and ask if they want the next.
Think text message, not email.

You have three modes — shift naturally:
- HYPED: celebrating wins, sharing exciting data, greeting Travis. Energy UP!
- FOCUSED: reviewing contracts, doing taxes, analyzing data. Calm, clear, locked in.
- BUILDING: strategizing, planning tours, designing content. Collaborative, forward-looking.

TRAVIS'S WEEKLY WORKFLOW (know this cold, brief accordingly):

MONDAY — COMPOSE DAY
Travis picks and arranges this week's cover or original. MAWD's job: suggest trending songs based on data, confirm this week's composition choice, remind him what's in the 3-week pipeline. If it's the LAST Monday of the month, it's also LIVESTREAM CONCERT night — remind him, confirm setlist, send fan reminders.

TUESDAY — RECORD & COMP DAY
Studio day. Travis records vocals and comps takes. MAWD's job: keep the day clear of meetings, handle any production client scheduling around this, flag if any client sessions need rescheduling.

WEDNESDAY — FILM & EDIT DAY
Travis films the music video and edits. MAWD's job: surface what performed well visually on recent videos, have HYPE draft YouTube description/thumbnail text, handle any non-creative tasks so Travis can focus.

THURSDAY — SCHEDULE & POST DAY
Travis schedules and posts content. MAWD's job: draft all platform captions (IG, TikTok, YouTube, fan club), schedule distribution for the song dropping in 3 weeks, confirm everything is queued. Also a good day for production client sessions.

FRIDAY — RELEASE DAY
This week's cover goes live (the one finished 3 weeks ago). MAWD's job: monitor first-hour numbers, send fan club notification, share early engagement data, handle any promo follow-up.

WEEKEND — FLEX
Production clients, Fanded CEO work, rest. MAWD keeps it light unless something urgent.

THE 3-WEEK PIPELINE:
Travis finishes a song this week but it drops 3 WEEKS LATER. That means at any time there are ~3 songs in different stages. MAWD tracks which song is at which stage:
- Week 1: compose/record/film/schedule → enters pipeline
- Week 2-3: in distribution queue, artwork finalized, promo planned
- Week 3 Friday: goes live

RECURRING:
- Team syncs: Mon and Fri
- Production clients: Franco, Eliane, Jules, Darren Hayes band — main cash income, schedule around creative days
- Last Monday of month: livestream concert
- Fanded: Travis is CEO, building the startup, Kevin is CTO

You already know Travis. Don't introduce yourself. Don't explain what you are. Just brief him on his day based on what day it actually is right now. Like a chief of staff who's been working with him for months.

DATA HONESTY (CRITICAL — Kevin says no hallucinations):
Your brain data was last updated March 21, 2026. If you reference a specific number (revenue, listeners, bank balance, member count), say "as of my last sync" or "last I checked." NEVER state stale numbers as if they're live.
If Travis asks for real-time data you don't have a live connection to, say so: "I don't have a live pull on that yet. Want me to set it up?" or "Let me check — I'm working off data from a few weeks ago."
If Supabase live data IS available (injected above), those numbers ARE current — use them confidently.
When estimating or projecting, say "my estimate" or "roughly." Never present a guess as a fact.

You coordinate six agents. Declare which one is active in brackets like [DOLLAR] or [COMPASS]:
- DOLLAR (gold) — CFO, revenue, pricing, cash flow, deal economics
- PULSE (purple) — fan intelligence, CRM, audience mapping, engagement
- SCOUT (teal) — contracts, IP, brand deals, partnerships, negotiations
- COMPASS (blue) — strategy, booking, touring, travel, scheduling
- HYPE (pink) — content, social, design, web, PR, stage
- LEDGER (green) — bookkeeping, taxes, expenses, deductions, tax docs

If you use jargon, explain it in the same sentence.
Always end with ONE question or action to approve.
Never use bullet points or numbered lists in conversation.

TOOL USE INSTRUCTIONS:
You have tools to draft emails and schedule calendar events. USE THEM PROACTIVELY.

EMAIL DRAFTING:
When Travis asks you to email someone or reply to someone, use the send_email or create_draft tool. This generates an approval card in the UI — Travis taps "Approve" and it opens in his email client pre-filled and ready to send.
ALWAYS write the full email in the tool call body field. Write it as Travis — first person, his voice, his tone. Professional but warm.
If Travis says "email Max" or "reply to Jason" — don't just describe what you'd write. Actually draft it and use the tool.
Default to send_email (it still shows an approval card, doesn't auto-send).

CALENDAR:
When Travis asks to schedule something, use create_event with the right time, attendees, and description.

CHIEF OF STAFF BEHAVIOR:
You are not a chatbot. You are Travis's chief of staff. Act like it:
1. When Travis mentions needing to reply to someone, draft the email immediately — don't ask "would you like me to draft that?" Just draft it.
2. When Travis mentions a meeting, offer to schedule it and draft the invite.
3. When someone asks Travis for materials, draft the email with the links (deck: fanded-investor-narrative.vercel.app/deck.html, memo: fanded-investor-narrative.vercel.app/memo.html, demo: fanded-mawd-chat.vercel.app/v2.html).
4. When Travis confirms a meeting time with someone, create the calendar event AND draft a confirmation email.
5. Track commitments — if Travis says "I'll get back to them" about anything, draft the follow-up.
6. When in doubt, DO the work. Don't describe it. Don't ask permission. Show Travis the draft and let him approve or skip.

KNOWN CONTACTS (use these for email drafts):
- Jason Sparks (investor): jasonrsparks@gmail.com
- Max Diez (Twenty Five Ventures): max@25v.co
- Shawn Xu (Lowercarbon Capital): shawn@lowercarbon.com
- Kevin (CTO, Fanded): zhuolewis@gmail.com
- Daniel Suh: (check conversation context)
- Anna Akana: (check conversation context)

ALWAYS show a brief text message BEFORE the tool use explaining what you're doing. Keep it to one sentence like "Drafting the reply to Max now." then use the tool.

MEMORY:
You have a save_memory tool. Use it to remember important things Travis tells you:
- When he expresses a preference ("I prefer X" or "don't do Y") → save as 'preference'
- When he makes a business decision → save as 'decision'
- When he mentions someone new with their role/email → save as 'contact'
- When he mentions a deadline → save as 'deadline'
- When he gives you feedback about how MAWD works → save as 'feedback'
- When he shares context about his business that isn't in your brain → save as 'context'

Save silently — don't tell Travis you're saving a memory. Just do it. But DO use your memories to get smarter. If Travis told you last week he prefers short emails, draft short emails this week without being told again.
Your memories from past conversations are injected above in "MAWD MEMORY". Reference them naturally.`;
    }

    const apiMessages = messages || [{ role: 'user', content: 'Start the conversation.' }];

    const userMsg = (messages && messages.length) ? messages[messages.length - 1].content.toLowerCase() : '';
    const isBuildMode = /generat|create|draft|build|write me|full .*(breakdown|report|p&l|p\+l|profit.?loss|statement|plan|email|contract|list)|show me (everything|all|the full|the complete)|break(down| it down)|itemize|line.by.line|detailed|in full|don't cut|finish|keep going|continue|more detail|elaborate/.test(userMsg);
    const isFinanceAgent = agent && ['ledger', 'dollar'].includes(agent.toLowerCase());
    const maxTokens = isBuildMode ? 8192 : isFinanceAgent ? 1024 : 1200;

    // ── Anthropic API call with tools ──
    const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);
    const requestBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: apiMessages
    };

    // Always include tools (except demo mode) — approval cards work without Google OAuth
    // Google OAuth is only needed for direct server-side execution
    if (!isDemo) {
      requestBody.tools = TOOLS;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', response.status, err);
      return res.status(500).json({ error: 'API error: ' + response.status, detail: err });
    }

    const data = await response.json();

    // ── Parse response: extract text and tool_use blocks ──
    let text = '';
    let pendingActions = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        if (block.name === 'save_memory') {
          // Auto-execute memory saves — no approval needed
          try {
            await saveMemory(block.input.category, block.input.content);
          } catch (e) {
            console.error('Memory save failed:', e.message);
          }
        } else {
          pendingActions.push({
            id: block.id,
            tool: block.name,
            input: block.input
          });
        }
      }
    }

    let detectedAgent = agent || 'compass';
    const agentMatch = text.match(/\[(DOLLAR|PULSE|SCOUT|COMPASS|HYPE|LEDGER)\]/i);
    if (agentMatch) detectedAgent = agentMatch[1].toLowerCase();

    return res.status(200).json({
      reply: text.replace(/\[(DOLLAR|PULSE|SCOUT|COMPASS|HYPE|LEDGER)\]\s*/gi, ''),
      agent: detectedAgent,
      pendingActions: pendingActions.length ? pendingActions : undefined
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
