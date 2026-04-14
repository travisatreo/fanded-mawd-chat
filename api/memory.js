// MAWD Memory API — Vercel serverless function
// GET  /api/memory             -> list all memories (grouped by category) + pinned
// POST /api/memory             -> { category, content } create a new memory
// PATCH /api/memory?id=XX      -> { content, category? } update a memory
// DELETE /api/memory?id=XX     -> delete a memory
// PUT /api/memory?pinned=1     -> { content } upsert the single pinned instructions

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, options) {
  options = options || {};
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': options.prefer || 'return=representation'
  };
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase ' + res.status + ': ' + text);
  }
  if (options.method === 'DELETE') return { ok: true };
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const id = req.query && req.query.id ? req.query.id : null;
    const isPinned = req.query && req.query.pinned === '1';

    // GET — list all
    if (req.method === 'GET') {
      const rows = await sb('mawd_memory?select=id,category,content,created_at&order=created_at.desc&limit=200');
      const pinned = rows.find(function(r){ return r.category === 'pinned'; });
      const others = rows.filter(function(r){ return r.category !== 'pinned'; });
      const grouped = {};
      others.forEach(function(m){
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m);
      });
      return res.status(200).json({
        pinned: pinned ? pinned.content : '',
        pinnedId: pinned ? pinned.id : null,
        grouped: grouped,
        total: others.length
      });
    }

    // PUT ?pinned=1 — upsert pinned instructions
    if (req.method === 'PUT' && isPinned) {
      const body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
      const content = (body.content || '').trim();
      const existing = await sb('mawd_memory?category=eq.pinned&select=id&limit=1');
      if (existing.length > 0) {
        const rowId = existing[0].id;
        if (!content) {
          await sb('mawd_memory?id=eq.' + rowId, { method: 'DELETE' });
          return res.status(200).json({ deleted: true });
        }
        const updated = await sb('mawd_memory?id=eq.' + rowId, {
          method: 'PATCH',
          body: { content: content }
        });
        return res.status(200).json(Array.isArray(updated) ? updated[0] : updated);
      } else if (content) {
        const created = await sb('mawd_memory', {
          method: 'POST',
          body: { category: 'pinned', content: content, created_at: new Date().toISOString() }
        });
        return res.status(201).json(Array.isArray(created) ? created[0] : created);
      }
      return res.status(200).json({ ok: true });
    }

    // POST — create
    if (req.method === 'POST') {
      const body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
      const category = body.category || 'context';
      const content = (body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const created = await sb('mawd_memory', {
        method: 'POST',
        body: { category: category, content: content, created_at: new Date().toISOString() }
      });
      return res.status(201).json(Array.isArray(created) ? created[0] : created);
    }

    // PATCH — update
    if (req.method === 'PATCH') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
      const patch = {};
      if (body.content !== undefined) patch.content = body.content;
      if (body.category !== undefined) patch.category = body.category;
      const updated = await sb('mawd_memory?id=eq.' + id, { method: 'PATCH', body: patch });
      return res.status(200).json(Array.isArray(updated) ? updated[0] : updated);
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'id required' });
      await sb('mawd_memory?id=eq.' + id, { method: 'DELETE' });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Memory API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
