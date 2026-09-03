// api/tts.js
// Streams TTS audio bytes to the browser as they arrive from OpenAI.
// Using response.body pipe instead of arrayBuffer() cuts time-to-first-byte
// dramatically — the browser starts playing before OpenAI finishes encoding.
import { gate } from '../lib/gateway.js';
export const config = { runtime: 'nodejs' };

const ALLOWED_TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];

export default async function handler(req, res) {
  const g = await gate(req, res, { endpoint: 'tts', methods: ['POST'], auth: 'user' });
  if (!g.ok) return;

  const { text, voice, model, format } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const ttsModel  = ALLOWED_TTS_MODELS.includes(model) ? model : 'tts-1';
  const ttsVoice  = voice  || 'nova';
  const ttsFormat = format || 'mp3';
  const input     = text.slice(0, 4000);

  try {
    const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:           ttsModel,
        voice:           ttsVoice,
        input,
        response_format: ttsFormat,
      }),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      console.error('TTS upstream error:', oaiRes.status, errText);
      return res.status(502).json({ error: 'TTS upstream error', detail: errText });
    }

    // ── Stream bytes as they arrive — do NOT buffer with arrayBuffer() / blob() ──
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = oaiRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();

  } catch (err) {
    console.error('TTS handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.end();
    }
  }
}
