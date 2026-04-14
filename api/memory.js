// MAWD Memory API
// GET /api/memory            -> list all memories (grouped by category)
// POST /api/memory           -> { category, content } create a new memory
// PATCH /api/memory?id=XX    -> { content } update a memory's content
// DELETE /api/memory?id=XX   -> delete a memory
// PUT /api/memory/pinned     -> { content } upsert the single pinned instructions

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  // DELETE with return=minimal has no body
  if (options.method === 'DELETE') return { ok: true };
  return res.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    const isPinned = url.pathname.endsWith('/pinned') || url.searchParams.get('pinned') === '1';

    // ── GET: list all memories ──
    if (req.method === 'GET') {
      const rows = await sb('mawd_memory?select=id,category,content,created_at&order=created_at.desc&limit=200');
      // Split out pinned instructions from rest
      const pinned = rows.find(r => r.category === 'pinned');
      const others = rows.filter(r => r.category !== 'pinned');
      // Group others by category
      const grouped = {};
      for (const m of others) {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m);
      }
      return res.status(200).json({
        pinned: pinned ? pinned.content : '',
        pinnedId: pinned ? pinned.id : null,
        grouped,
        total: others.length
      });
    }

    // ── PUT /pinned: upsert the single pinned instructions ──
    if (req.method === 'PUT' && isPinned) {
      const body = await readBody(req);
      const content = (body.content || '').trim();
      // Find existing pinned row
      const existing = await sb(`mawd_memory?category=eq.pinned&select=id&limit=1`);
      if (existing.length > 0) {
        const row = existing[0];
        if (!content) {
          // Empty content -> delete the pinned row
          await sb(`mawd_memory?id=eq.${row.id}`, { method: 'DELETE' });
          return res.status(200).json({ deleted: true });
        }
        const updated = await sb(`mawd_memory?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { content }
        });
        return res.status(200).json(updated[0] || { ok: true });
      } else if (content) {
        const created = await sb('mawd_memory', {
          method: 'POST',
          body: { category: 'pinned', content, created_at: new Date().toISOString() }
        });
        return res.status(201).json(Array.isArray(created) ? created[0] : created);
      }
      return res.status(200).json({ ok: true });
    }

    // ── POST: create a new memory ──
    if (req.method === 'POST') {
      const body = await readBody(req);
      const category = body.category || 'context';
      const content = (body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const created = await sb('mawd_memory', {
        method: 'POST',
        body: { category, content, created_at: new Date().toISOString() }
      });
      return res.status(201).json(Array.isArray(created) ? created[0] : created);
    }

    // ── PATCH: update a memory by id ──
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const body = await readBody(req);
      const patch = {};
      if (body.content !== undefined) patch.content = body.content;
      if (body.category !== undefined) patch.category = body.category;
      const updated = await sb(`mawd_memory?id=eq.${id}`, { method: 'PATCH', body: patch });
      return res.status(200).json(updated[0] || { ok: true });
    }

    // ── DELETE: delete a memory by id ──
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb(`mawd_memory?id=eq.${id}`, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Memory API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return {}; }
}
