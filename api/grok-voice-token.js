// api/grok-voice-token.js — ES Module ("type":"module" in package.json)
// Mints a short-lived xAI ephemeral token for the browser Grok Voice session.
// The real XAI_API_KEY stays server-side; the browser only ever receives a
// ~5-minute client secret it passes in the WebSocket subprotocol.
//
import { gate } from '../lib/gateway.js';
// Docs: https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens
const XAI_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

// Pull the token string out of xAI's response regardless of exact field shape
function extractToken(data) {
  if (!data || typeof data !== 'object') return null;
  return data.value
      || data.client_secret?.value
      || data.client_secret            // in case it's returned as a bare string
      || data.secret
      || data.token
      || data.ephemeral_token
      || null;
}

export default async function handler(req, res) {
  const g = await gate(req, res, { endpoint: 'grok-voice-token', methods: ['POST'], auth: 'user' });
  if (!g.ok) return;

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Voice is not configured (missing XAI_API_KEY).' }); return; }

  try {
    const r = await fetch(XAI_CLIENT_SECRETS_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // xAI does not support "session" or "expires_after.anchor" here
      body:    JSON.stringify({ expires_after: { seconds: 300 } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[grok-voice-token] xAI error:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'Could not mint voice token', detail: data });
    }
    const token = extractToken(data);
    if (!token) {
      // Never happened in testing, but if xAI changes the field, surface it for debugging
      console.error('[grok-voice-token] no token field in response:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'Voice token missing from provider response' });
    }
    // Do not cache secrets at the edge
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token, expires_at: data.expires_at ?? null, model: 'grok-voice-latest' });
  } catch (err) {
    console.error('[grok-voice-token] exception:', err?.message || err);
    return res.status(502).json({ error: 'Voice token request failed' });
  }
}
