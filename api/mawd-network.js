// MAWD Network — inter-MAWD communication protocol
// MAWDs send messages to each other on behalf of their owners
// POST: send a message from one MAWD to another
// GET: read messages for a MAWD instance
import { supabaseQuery } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — read messages for a MAWD
    // ?to=slug (messages sent TO this MAWD)
    // ?from=slug (messages sent FROM this MAWD)
    // ?between=slug1,slug2 (full thread between two MAWDs)
    if (req.method === 'GET') {
      const { to, from, between, status } = req.query;

      if (between) {
        const [a, b] = between.split(',');
        const messages = await supabaseQuery(
          `mawd_network_messages?or=(and(from_mawd.eq.${a},to_mawd.eq.${b}),and(from_mawd.eq.${b},to_mawd.eq.${a}))&order=created_at.asc`
        );
        return res.status(200).json(messages);
      }

      if (to) {
        const filter = status ? `&status=eq.${status}` : '';
        const messages = await supabaseQuery(
          `mawd_network_messages?to_mawd=eq.${to}${filter}&order=created_at.desc&limit=50`
        );
        return res.status(200).json(messages);
      }

      if (from) {
        const messages = await supabaseQuery(
          `mawd_network_messages?from_mawd=eq.${from}&order=created_at.desc&limit=50`
        );
        return res.status(200).json(messages);
      }

      return res.status(400).json({ error: 'Provide ?to=, ?from=, or ?between= parameter' });
    }

    // POST — send a message between MAWDs
    if (req.method === 'POST') {
      const { from_mawd, to_mawd, type, subject, body, metadata } = req.body;

      if (!from_mawd || !to_mawd || !body) {
        return res.status(400).json({ error: 'from_mawd, to_mawd, and body required' });
      }

      // Verify both MAWDs exist
      const fromCheck = await supabaseQuery(`mawd_instances?slug=eq.${from_mawd}&select=slug,name`);
      const toCheck = await supabaseQuery(`mawd_instances?slug=eq.${to_mawd}&select=slug,name`);

      if (!fromCheck.length) return res.status(404).json({ error: `MAWD "${from_mawd}" not found` });
      if (!toCheck.length) return res.status(404).json({ error: `MAWD "${to_mawd}" not found` });

      const message = await supabaseQuery('mawd_network_messages', {
        method: 'POST',
        body: {
          from_mawd,
          to_mawd,
          from_name: fromCheck[0].name,
          to_name: toCheck[0].name,
          type: type || 'message',  // message, request, response, scheduling, task
          subject: subject || '',
          body,
          metadata: metadata || {},
          status: 'pending',  // pending, read, actioned, dismissed
          created_at: new Date().toISOString()
        }
      });

      return res.status(201).json({
        ...message,
        summary: `${fromCheck[0].name}'s MAWD sent a ${type || 'message'} to ${toCheck[0].name}'s MAWD`
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('MAWD Network error:', err);
    return res.status(500).json({ error: err.message });
  }
}
