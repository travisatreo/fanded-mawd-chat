// MAWD Journal API
// Handles voice memo upload, transcription, MAWD summary, and fan-facing drop pages
// POST /api/journal { audio: base64, attachmentUrl?, title? }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY; // For Whisper transcription

// ── Upload audio to Supabase Storage ──
async function uploadAudio(base64Audio, filename) {
  // Decode base64 to buffer
  const buffer = Buffer.from(base64Audio, 'base64');

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/journal/${filename}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'audio/webm',
      'x-upsert': 'true'
    },
    body: buffer
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Upload failed: ' + err);
  }

  // Return public URL
  return `${SUPABASE_URL}/storage/v1/object/public/journal/${filename}`;
}

// ── Transcribe audio via OpenAI Whisper ──
async function transcribeAudio(base64Audio) {
  if (!OPENAI_KEY) {
    return { text: '[Transcription unavailable - OpenAI key not configured]' };
  }

  const buffer = Buffer.from(base64Audio, 'base64');

  // Create form data for Whisper API
  const boundary = '----FormBoundary' + Date.now();
  const formParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
    buffer,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`
  ];

  const body = Buffer.concat([
    Buffer.from(formParts[0]),
    formParts[1],
    Buffer.from(formParts[2])
  ]);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Whisper error:', err);
    return { text: '[Transcription failed]' };
  }

  return res.json();
}

// ── Generate MAWD Summary via Claude ──
async function generateSummary(transcript, title) {
  if (!ANTHROPIC_KEY) return 'MAWD summary unavailable.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are MAWD, Travis Atreo's AI moderator. Write a brief, warm summary of Travis's voice memo for his fans. 2-3 sentences max. Write in third person about Travis. Be concise and capture the emotion/intent. No em dashes. If he mentions a song or project, name it. If he's sharing something vulnerable, honor that tone.`,
      messages: [
        { role: 'user', content: `Travis recorded a voice memo${title ? ' about "' + title + '"' : ''}. Here's what he said:\n\n"${transcript}"\n\nWrite the MAWD summary for fans who can't listen right now.` }
      ]
    })
  });

  if (!res.ok) return 'MAWD is processing this voice note.';

  const data = await res.json();
  return data.content?.[0]?.text || 'MAWD is processing this voice note.';
}

// ── Save journal entry to Supabase ──
async function saveJournalEntry(entry) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(entry)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Save failed: ' + err);
  }

  return (await res.json())[0];
}

// ── API Handler ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: Fetch journal entries
  if (req.method === 'GET') {
    try {
      const entries = await fetch(`${SUPABASE_URL}/rest/v1/journal_entries?select=*&order=created_at.desc&limit=20`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      return res.status(200).json(await entries.json());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { audio, title, attachmentUrl } = req.body || {};

  if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const entryId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const filename = `voice_${entryId}.webm`;

    // 1. Upload audio to storage
    const audioUrl = await uploadAudio(audio, filename);

    // 2. Transcribe
    const transcription = await transcribeAudio(audio);
    const transcript = transcription.text || '';

    // 3. Generate MAWD summary
    const summary = await generateSummary(transcript, title);

    // 4. Save journal entry
    const entry = await saveJournalEntry({
      id: entryId,
      title: title || 'Voice note',
      audio_url: audioUrl,
      attachment_url: attachmentUrl || null,
      transcript,
      mawd_summary: summary,
      fan_count: 695,
      listens: 0,
      replies: 0,
      created_at: new Date().toISOString()
    });

    // 5. Return the entry with the fan-facing link
    return res.status(200).json({
      ...entry,
      dropUrl: `https://fanded-mawd-chat.vercel.app/drop.html?id=${entryId}`
    });

  } catch (err) {
    console.error('Journal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
