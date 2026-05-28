// api/tts.js
// Text-to-speech via OpenAI gpt-4o-mini-tts. Model-agnostic — speaks any reply,
// whether it came from Claude or GPT. Returns MP3 audio bytes.
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  // gpt-4o-mini-tts accepts ~2000 input tokens; cap to stay safely under it.
  const input = text.slice(0, 4000);

  try {
    const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: voice || 'nova',   // nova = warm/friendly; also: alloy, echo, shimmer, sage, coral...
        input,
        response_format: 'mp3',
      }),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      console.error('TTS upstream error:', oaiRes.status, errText);
      return res.status(502).json({ error: 'TTS upstream error', detail: errText });
    }

    const audioBuf = Buffer.from(await oaiRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audioBuf);
  } catch (err) {
    console.error('TTS handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
