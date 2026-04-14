// ElevenLabs TTS proxy — keeps API key server-side, streams MP3 back to the client
// POST /api/tts { text, voiceId?, modelId? } → audio/mpeg stream
//
// Env vars required:
//   ELEVENLABS_API_KEY  — your xi-api-key
//   ELEVENLABS_VOICE_ID — default voice (optional; can be overridden per request)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  const body = typeof req.body === 'object' ? req.body : (req.body ? JSON.parse(req.body) : {});
  const text = (body.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  // Strip markdown so the voice doesn't read asterisks etc.
  const speakable = text
    .replace(/```[\s\S]*?```/g, ' ')      // code blocks
    .replace(/`[^`]*`/g, ' ')              // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
    .replace(/\*([^*]+)\*/g, '$1')          // italic
    .replace(/^#+\s+/gm, '')                // headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → just the text
    .replace(/^[-*•→]\s+/gm, '')            // list bullets
    .replace(/\n{2,}/g, '. ')               // paragraph breaks → pause
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);                        // safety cap

  const voiceId = body.voiceId || process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Sarah default
  const modelId = body.modelId || 'eleven_turbo_v2_5';

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: speakable,
          model_id: modelId,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: 'ElevenLabs error', detail: errText });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
