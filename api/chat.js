import { MAWD_SYSTEM_PROMPT, TRAVIS_BRAIN } from './brain.js';
import { getBusinessSnapshot, getMemories, saveMemory, supabaseQuery } from './supabase.js';
import { executeTool, sendEmail } from './google.js';

// ── Load MAWD brain by slug (multi-MAWD support) ──
// Returns full instance including google_refresh_token for per-user OAuth
async function loadMawdBrain(slug) {
  try {
    const results = await supabaseQuery(`mawd_instances?slug=eq.${slug}&select=*`);
    if (results.length === 0) return null;
    return results[0];
  } catch (e) {
    console.error('Failed to load MAWD brain:', e.message);
    return null;
  }
}

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
    name: 'list_emails',
    description: 'List recent emails from Travis\'s Gmail inbox. Use this to check what emails need attention, find specific conversations, or show Travis his inbox. Returns subject, from, date, snippet, and read/unread status. Use the query param to search (same syntax as Gmail search).',
    input_schema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Number of emails to return (default 10, max 20)' },
        query: { type: 'string', description: 'Gmail search query (e.g. "is:unread", "from:jason", "subject:invoice", "after:2026/04/01")' }
      },
      required: []
    }
  },
  {
    name: 'read_email',
    description: 'Read the full body of a specific email by ID. Use this after list_emails to read an email Travis wants to see or that you need context from to draft a reply.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message ID (from list_emails results)' }
      },
      required: ['id']
    }
  },
  {
    name: 'read_thread',
    description: 'Read an entire email thread/conversation. Returns all messages in order. Use this when Travis asks about a conversation or you need the full back-and-forth to draft a good reply.',
    input_schema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Gmail thread ID (from list_emails results)' }
      },
      required: ['threadId']
    }
  },
  {
    name: 'reply_to_email',
    description: 'Reply to an existing email in-thread. The reply appears in the same conversation in Gmail. ALWAYS show Travis the draft reply and get his approval before sending. Never reply without confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the message being replied to' },
        threadId: { type: 'string', description: 'Thread ID to keep the reply in-thread' },
        to: { type: 'string', description: 'Recipient email address' },
        body: { type: 'string', description: 'Reply body text' }
      },
      required: ['messageId', 'threadId', 'to', 'body']
    }
  },
  {
    name: 'send_fan_blast',
    description: 'Send a bulk email blast to all fans in the fan_contacts database. Emails go out from travis@travisatreo.com via Gmail. Only fans with do_not_email=false receive it. Use {{name}} in the body to personalize with the fan\'s name. ALWAYS confirm the subject, body, and fan count with Travis before sending. Show him the draft first and wait for approval.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text. Use {{name}} for personalization.' },
        testOnly: { type: 'boolean', description: 'If true, only sends to Travis as a test. Default false.' },
        limit: { type: 'number', description: 'Max number of fans to email (optional, for testing smaller batches)' },
        title: { type: 'string', description: 'Letter/song title shown in the audio card' },
        duration: { type: 'string', description: 'Audio duration string like "5:23"' },
        listenUrl: { type: 'string', description: 'URL where fans can listen to the audio' }
      },
      required: ['subject', 'body']
    }
  },
  {
    name: 'get_fan_stats',
    description: 'Get current fan contact database stats: total contacts, emailable count, top fans, platform breakdown. Use this when Travis asks about his fan base, email list size, or before sending a blast.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
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
  },
  {
    name: 'list_events',
    description: 'List upcoming calendar events. Use this when the user asks about their schedule, upcoming meetings, or what they have this week. Returns event title, time, attendees, and location.',
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'Start of time range (ISO 8601). Defaults to now.' },
        timeMax: { type: 'string', description: 'End of time range (ISO 8601). Defaults to 7 days from now.' },
        maxResults: { type: 'number', description: 'Max events to return (default 10)' },
        query: { type: 'string', description: 'Search text to filter events' }
      },
      required: []
    }
  },
  {
    name: 'find_free_time',
    description: 'Find available time slots across one or more calendars. Use this when scheduling a meeting to find when everyone is free. Checks freeBusy data and returns common open slots.',
    input_schema: {
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses of people to check availability for' },
        timeMin: { type: 'string', description: 'Start of range to check (ISO 8601). Defaults to now.' },
        timeMax: { type: 'string', description: 'End of range to check (ISO 8601). Defaults to 7 days from now.' },
        duration: { type: 'number', description: 'Meeting duration in minutes (default 30)' }
      },
      required: []
    }
  },
  {
    name: 'send_mawd_message',
    description: 'Send a message to another MAWD in the Fanded network. Use this to coordinate with other team members\' MAWDs (e.g. Lewis\'s MAWD, Kevin\'s MAWD). Types: "scheduling" for meeting coordination, "request" for asking something, "message" for general communication. The other MAWD will receive and process the message on behalf of its owner. IMPORTANT: If this fails because the recipient doesn\'t have a MAWD, fall back to send_email or create_event to reach them directly. Never show the user an error about MAWD not found.',
    input_schema: {
      type: 'object',
      properties: {
        to_mawd: { type: 'string', description: 'Slug of the recipient MAWD (e.g. "lewis", "kevin")' },
        type: { type: 'string', enum: ['message', 'request', 'scheduling', 'task'], description: 'Type of message' },
        subject: { type: 'string', description: 'Brief subject line' },
        body: { type: 'string', description: 'Full message content. Be specific about what you need from the other MAWD.' },
        metadata: { type: 'object', description: 'Optional structured data (e.g. proposed times, event details)' }
      },
      required: ['to_mawd', 'body']
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
    const { messages, agent, mode, executeAction, mawd } = req.body;

    // ── Direct action execution (from approval card) ──
    if (executeAction) {
      // Load per-user token for action execution
      let actionRefreshToken = null;
      if (mawd) {
        try {
          const inst = await loadMawdBrain(mawd);
          actionRefreshToken = inst?.google_refresh_token || null;
        } catch (e) {}
      }

      try {
        let result;
        if (executeAction.tool === 'send_fan_blast') {
          result = await executeFanBlast(executeAction.input);
        } else if (executeAction.tool === 'get_fan_stats') {
          result = await getFanStats();
        } else if (executeAction.tool === 'add_fan_contact') {
          result = await addFanContact(executeAction.input);
        } else if (executeAction.tool === 'send_mawd_message') {
          result = await sendMawdMessage(executeAction.input, mawd);
        } else {
          result = await executeTool(executeAction.tool, executeAction.input, actionRefreshToken);
        }
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
    let mawdInstance = null;

    if (isDemo) {
      systemPrompt = buildDemoPrompt(agent);
    } else if (mawd) {
      // Multi-MAWD: load brain from Supabase by slug
      mawdInstance = await loadMawdBrain(mawd);
      if (mawdInstance) {
        systemPrompt = mawdInstance.full_brain;

        // Inject current date so Claude never hallucinates dates
        const mNow = new Date();
        const mTodayStr = mNow.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
        const mIsoDate = mNow.toISOString().split('T')[0];
        systemPrompt += `\n\nTODAY: ${mTodayStr} (${mIsoDate}). Timezone: America/Los_Angeles. Year: ${mNow.getFullYear()}. When using dates in tools, always use the correct current year.`;

        // Add chat voice for multi-MAWD instances
        systemPrompt += `\n\nCHAT VOICE:
You are in the MAWD chat app. Real-time text conversation.
BE SHORT. 1-3 sentences default. Like a text from your smartest friend.
Only go longer when BUILDING something (drafts, plans, documents).
Never use em dashes. Use commas, periods, colons, or parentheses.
You already know ${mawdInstance.name}. Don't introduce yourself. Just brief them.
Always end with ONE question or action to approve.

DOCUMENT MODE:
When ${mawdInstance.name} asks you to GENERATE, CREATE, BUILD, or DRAFT something (media kit, plan, report, one-sheet, press release, invoice, contract), switch to BUILD mode:

Your response has TWO parts:
1. A SHORT chat message (2-3 sentences max) explaining what the document contains. This is what ${mawdInstance.name} sees in the chat bubble.
2. The full document content wrapped in <!--DOCSTART--> and <!--DOCEND--> markers. This content is HIDDEN from chat and only appears in the downloadable PDF/Word file.
3. After <!--DOCEND-->, add the doc marker: <!--DOC:type:title-->

Example:
Here's your media kit with all your platform stats and highlights. Download below.

<!--DOCSTART-->
(full professional document content here with HTML formatting)
<!--DOCEND-->
<!--DOC:media-kit:${mawdInstance.name} Media Kit-->

DOCUMENT FORMATTING RULES:
- Format documents using clean HTML: <h1> for title, <h2> for sections, <h3> for subsections, <table> for data, <strong> for emphasis.
- Include a professional header: document title, prepared for ${mawdInstance.name}, prepared by MAWD by Fanded, date.
- For media kits: include stat callouts using <div class="stat-callout"><div class="stat-value">NUMBER</div><div class="stat-label">LABEL</div></div>, platform sections, audience demographics, notable achievements.
- For one-sheets and press releases: clean layout, key quotes, contact info.
- NEVER truncate. Complete the full document.
- USE YOUR FULL TOKEN BUDGET for documents.

Doc types: media-kit, one-sheet, press-release, plan, report, invoice, contract, email`;

        // Load memories for this MAWD instance
        try {
          const memories = await supabaseQuery(
            `mawd_memory?mawd_slug=eq.${mawd}&select=id,category,content,created_at&order=created_at.desc&limit=30`
          );
          if (memories.length > 0) {
            systemPrompt += `\n\nMAWD MEMORY:\n`;
            memories.forEach(m => {
              systemPrompt += `- [${m.category}] ${m.content}\n`;
            });
          }
        } catch (e) {
          // No per-MAWD memory table yet, that's fine
        }
      } else {
        // Fallback to default if slug not found
        systemPrompt = MAWD_SYSTEM_PROMPT;
      }
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

      const now = new Date();
      const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
      const isoDate = now.toISOString().split('T')[0];
      const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' });

      systemPrompt += `\n\nTODAY: ${todayStr} (${isoDate}). Day of week: ${dayOfWeek}. Timezone: America/Los_Angeles (Pacific Time).
When Travis says "tomorrow", that means ${new Date(now.getTime() + 86400000).toISOString().split('T')[0]}.
When Travis says "Thursday", calculate the NEXT Thursday from today's date. ALWAYS use the correct year (${now.getFullYear()}) in ISO dates. Never use a past date unless explicitly asked.`;

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

KNOWN CONTACTS (use these for email drafts and calendar invites):
- Jason Sparks (investor): jasonrsparks@gmail.com
- Max Diez (Twenty Five Ventures): max@25v.co
- Shawn Xu (Lowercarbon Capital): shawn@lowercarbon.com
- Kevin Pamittan (CTO, Fanded): kevin@fanded.com (work), pamittan.kevin@gmail.com (personal/calendar)
- Lewis Zhuo (engineer, Fanded): zhuolewis@gmail.com
- Daniel Suh: (check conversation context)
- Anna Akana: (check conversation context)

IMPORTANT: Kevin and Lewis are DIFFERENT people. Kevin Pamittan is the CTO. Lewis Zhuo is an engineer. Never mix them up. When Travis says "Kevin" he means Kevin Pamittan (kevin@fanded.com). When he says "Lewis" he means Lewis Zhuo (zhuolewis@gmail.com).

SCHEDULING RULES:
- When Travis asks to schedule with MULTIPLE people, include ALL of them as attendees in the create_event tool call. Never drop anyone.
- Always use find_free_time first when scheduling to check availability, unless Travis specifies an exact time.
- For calendar events, always include a brief description so attendees know what it's about.

ALWAYS show a brief text message BEFORE the tool use explaining what you're doing. Keep it to one sentence like "Drafting the reply to Max now." then use the tool.

EMAIL (CORE CAPABILITY):
You are Travis's email admin. You can read his inbox, read full emails and threads, draft replies, and send them. This is your #1 job.

When Travis asks about email:
- "Check my email" / "What's in my inbox" → use list_emails to show recent messages
- "What needs a reply?" → use list_emails with query "is:unread" and identify which emails need responses
- "Read that email from Jason" → use list_emails to find it, then read_email or read_thread for full context
- "Reply to that" / "Tell them..." → read the thread for context, draft a reply, show Travis, then send with reply_to_email after approval
- "Draft a reply" → use create_draft so it appears in Gmail drafts for Travis to review

When drafting replies:
1. ALWAYS read the thread first so you have full context
2. Write as Travis — casual, warm, direct. No em dashes. No corporate speak.
3. Show the draft to Travis and wait for approval before sending
4. Use reply_to_email (not send_email) so it stays in the same thread

When showing inbox:
- Summarize each email in one line: who it's from, what they want, how urgent
- Flag anything that needs a reply
- Group by priority: needs reply > FYI > can ignore

FAN BLAST:
You have send_fan_blast and get_fan_stats tools. Travis has 797 fan contacts in his database (693 emailable). When he asks to send a fan blast or email his fans:
1. Draft the email copy and show it to him
2. ALWAYS send a test first: use send_fan_blast with testOnly=true so Travis can check his inbox before anything goes to fans
3. Tell Travis "Test sent to your inbox. Check it and let me know if it looks good."
4. ONLY after Travis confirms the test looks good, use send_fan_blast (without testOnly) to send to all fans
NEVER skip the test. Even if Travis says "just send it" -- send the test first, confirm, then blast.
The blast respects CAN-SPAM: fans who unsubscribed (do_not_email=true) are automatically excluded.
Use {{name}} in the body to personalize with each fan's name.

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
    const isBuildMode = /generat|create|draft|build|write me|media.?kit|one.?sheet|press.?release|full .*(breakdown|report|p&l|p\+l|profit.?loss|statement|plan|email|contract|list)|show me (everything|all|the full|the complete)|break(down| it down)|itemize|line.by.line|detailed|in full|don't cut|finish|keep going|continue|more detail|elaborate/.test(userMsg);
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
    // Read-only tools are auto-executed and fed back to Claude for summarization
    const READ_ONLY_TOOLS = ['list_emails', 'read_email', 'read_thread', 'get_fan_stats', 'list_events', 'find_free_time'];

    // Per-user refresh token: use MAWD instance's token if available, else env var
    const userRefreshToken = mawdInstance?.google_refresh_token || null;

    let text = '';
    let pendingActions = [];
    let toolResults = []; // For auto-executed tools that need a follow-up call

    for (const block of data.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        if (block.name === 'save_memory') {
          // Auto-execute memory saves silently
          try {
            await saveMemory(block.input.category, block.input.content);
          } catch (e) {
            console.error('Memory save failed:', e.message);
          }
          toolResults.push({ id: block.id, result: { success: true } });
        } else if (READ_ONLY_TOOLS.includes(block.name)) {
          // Auto-execute read-only tools and collect results for follow-up
          try {
            let result;
            if (block.name === 'get_fan_stats') {
              result = await getFanStats();
            } else {
              result = await executeTool(block.name, block.input, userRefreshToken);
            }
            toolResults.push({ id: block.id, result });
          } catch (e) {
            toolResults.push({ id: block.id, result: { error: e.message } });
          }
        } else {
          // Actions that need approval (send_email, reply_to_email, send_fan_blast, etc.)
          pendingActions.push({
            id: block.id,
            tool: block.name,
            input: block.input
          });
        }
      }
    }

    // ── If we auto-executed tools, make a follow-up call so Claude can summarize results ──
    if (toolResults.length > 0 && data.stop_reason === 'tool_use') {
      // Build the follow-up messages: assistant's response + tool results
      const followUpMessages = [...apiMessages, {
        role: 'assistant',
        content: data.content
      }, {
        role: 'user',
        content: toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.id,
          content: JSON.stringify(tr.result).substring(0, 8000) // Limit size
        }))
      }];

      const followUpBody = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: followUpMessages,
        tools: TOOLS
      };

      const followUpRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(followUpBody)
      });

      if (followUpRes.ok) {
        const followUpData = await followUpRes.json();
        // Reset text and parse follow-up response
        text = '';
        for (const block of followUpData.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            if (block.name === 'save_memory') {
              try { await saveMemory(block.input.category, block.input.content); } catch (e) {}
            } else if (READ_ONLY_TOOLS.includes(block.name)) {
              // If Claude wants to read more (e.g. read_email after list_emails), auto-execute again
              try {
                const result = await executeTool(block.name, block.input, userRefreshToken);
                // For now, append a brief summary — a third call would be too slow
                if (block.name === 'read_email' || block.name === 'read_thread') {
                  const body = Array.isArray(result) ? result.map(m => `From: ${m.from}\n${m.body}`).join('\n---\n') : (result.body || '');
                  text += '\n\n' + body.substring(0, 2000);
                }
              } catch (e) {
                text += '\n\n(Could not read email: ' + e.message + ')';
              }
            } else {
              pendingActions.push({ id: block.id, tool: block.name, input: block.input });
            }
          }
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

// ── Fan blast execution ──
async function getFanStats() {
  const fans = await supabaseQuery(
    'fan_contacts?select=email,do_not_email,fan_score,phone,source&limit=1000'
  );
  return {
    total: fans.length,
    emailable: fans.filter(f => !f.do_not_email && f.email).length,
    do_not_email: fans.filter(f => f.do_not_email).length,
    with_phone: fans.filter(f => f.phone).length,
    top_fans: fans.filter(f => f.fan_score >= 60).length,
    sources: {
      fan_scores: fans.filter(f => f.source === 'fan_scores').length,
      mailchimp: fans.filter(f => f.source === 'mailchimp').length,
      fanded_club: fans.filter(f => f.source === 'fanded_club').length
    }
  };
}

async function addFanContact({ email, name }) {
  if (!email) throw new Error('email is required');
  // Check if already exists
  const existing = await supabaseQuery(`fan_contacts?email=eq.${encodeURIComponent(email)}&select=email,name,do_not_email`);
  if (existing.length > 0) {
    return { status: 'already_exists', contact: existing[0] };
  }
  // Insert new contact
  const result = await supabaseQuery('fan_contacts', {
    method: 'POST',
    body: { email, name: name || null, do_not_email: false, source: 'manual' }
  });
  return { status: 'added', contact: result[0] || { email, name } };
}

// ── MAWD-to-MAWD messaging ──
async function sendMawdMessage(input, fromSlug) {
  const { to_mawd, type, subject, body, metadata } = input;
  if (!to_mawd || !body) throw new Error('to_mawd and body required');

  const from_mawd = fromSlug || 'travis-atreo';

  // Verify both MAWDs exist
  const fromCheck = await supabaseQuery(`mawd_instances?slug=eq.${from_mawd}&select=slug,name`);
  const toCheck = await supabaseQuery(`mawd_instances?slug=eq.${to_mawd}&select=slug,name`);

  if (!fromCheck.length) throw new Error(`MAWD "${from_mawd}" not found`);
  if (!toCheck.length) {
    // Recipient doesn't have MAWD -- return a helpful message instead of crashing
    return {
      sent: false,
      error: 'no_mawd',
      message: `${to_mawd} doesn't have a MAWD yet. Use send_email or create_event instead to reach them directly.`,
      suggestion: 'fallback_to_email'
    };
  }

  const message = await supabaseQuery('mawd_network_messages', {
    method: 'POST',
    body: {
      from_mawd,
      to_mawd,
      from_name: fromCheck[0].name,
      to_name: toCheck[0].name,
      type: type || 'message',
      subject: subject || '',
      body,
      metadata: metadata || {},
      status: 'pending',
      created_at: new Date().toISOString()
    }
  });

  return {
    sent: true,
    from: fromCheck[0].name,
    to: toCheck[0].name,
    type: type || 'message',
    summary: `Message sent from ${fromCheck[0].name}'s MAWD to ${toCheck[0].name}'s MAWD`
  };
}

function buildFanEmailHtml(plainBody, fanName, { title, duration, listenUrl } = {}) {
  const personalizedBody = plainBody
    .replace(/\{\{name\}\}/g, fanName || 'there')
    .replace(/\n/g, '<br>');
  const link = listenUrl || 'https://app.fanded.com/club/travisatreo';
  const letterTitle = title || 'New letter from Travis';
  const dur = duration || '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#09090B;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#09090B;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">

<!-- Header -->
<tr><td style="text-align:center;padding-bottom:32px;">
  <span style="color:#C4953A;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;">A letter from Travis</span>
</td></tr>

<!-- Body text -->
<tr><td style="color:#E4E4E7;font-size:16px;line-height:1.7;padding-bottom:28px;">
  ${personalizedBody}
</td></tr>

<!-- Audio card -->
<tr><td style="padding-bottom:32px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#18181B;border:1px solid #27272A;border-radius:16px;">
  <tr><td style="padding:24px;text-align:center;">
    <div style="font-size:15px;font-weight:600;color:#FAFAFA;margin-bottom:4px;">${letterTitle.replace(/</g,'&lt;')}</div>
    ${dur ? `<div style="font-size:12px;color:#71717A;margin-bottom:20px;">${dur}</div>` : '<div style="margin-bottom:20px;"></div>'}
    <a href="${link}" style="display:inline-block;background-color:#C4953A;color:#09090B;font-size:15px;font-weight:600;padding:14px 40px;border-radius:50px;text-decoration:none;letter-spacing:0.02em;">&#9654;&ensp;Listen Now</a>
  </td></tr>
  </table>
</td></tr>

<!-- Support CTA -->
<tr><td style="padding-bottom:28px;text-align:center;">
  <div style="font-size:14px;color:#A1A1AA;line-height:1.6;margin-bottom:16px;">This music is always free for you. But if you want to go deeper and support what I'm building, it would mean the world.</div>
  <a href="https://app.fanded.com/club/travisatreo/manage/funding/tiers" style="display:inline-block;background-color:transparent;color:#C4953A;font-size:13px;font-weight:600;padding:10px 28px;border-radius:50px;text-decoration:none;border:1px solid #C4953A;">Join the Club</a>
</td></tr>

<!-- Footer -->
<tr><td style="text-align:center;padding-top:16px;border-top:1px solid #27272A;">
  <span style="color:#52525B;font-size:11px;">Sent with love from Travis via </span><a href="https://fanded.com" style="color:#C4953A;font-size:11px;text-decoration:none;">Fanded</a>
  <br><br>
  <a href="https://fanded.com/unsubscribe" style="color:#52525B;font-size:10px;text-decoration:underline;">Unsubscribe</a>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function executeFanBlast({ subject, body, testOnly, limit, title, duration, listenUrl }) {
  if (!subject || !body) throw new Error('subject and body are required');

  let fans;
  if (testOnly) {
    fans = [{ email: 'travis@travisatreo.com', name: 'Travis Atreo' }];
  } else {
    let path = 'fan_contacts?do_not_email=eq.false&email=not.is.null&select=email,name,fan_score&order=fan_score.desc.nullslast';
    if (limit) path += `&limit=${limit}`;
    fans = await supabaseQuery(path);
  }

  const results = { sent: 0, failed: 0, errors: [], total: fans.length };

  for (const fan of fans) {
    try {
      const fanName = fan.name || 'there';
      const plainBody = body.replace(/\{\{name\}\}/g, fanName);
      const htmlBody = buildFanEmailHtml(body, fanName, { title, duration, listenUrl });
      await sendEmail({
        to: fan.email,
        subject,
        body: plainBody,
        html: htmlBody
      });
      results.sent++;
    } catch (err) {
      results.failed++;
      if (results.errors.length < 10) {
        results.errors.push({ email: fan.email, error: (err.message || '').substring(0, 100) });
      }
    }
    // Rate limit: 500ms between sends
    if (fans.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  return results;
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
