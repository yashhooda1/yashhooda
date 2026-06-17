// api/gmail-agent.js
// Gmail integration via Google MCP
// Handles: read inbox, draft replies, send emails

import { notifyFailure } from './_notify.js';

export const maxDuration = 30;

const GMAIL_MCP_URL = 'https://gmailmcp.googleapis.com/mcp/v1';

const GMAIL_SYSTEM = `You are Yash Hooda's personal Gmail assistant.
You have access to Gmail via MCP tools.
For read requests: fetch and summarize emails clearly. Show sender, subject, date, and a 1-2 sentence summary per email.
For draft requests: compose a professional email and show it formatted clearly with To/Subject/Body.
For send requests: always confirm with the user before sending — show the draft and ask "Should I send this?"
Format all responses in clean markdown. Be concise and professional.
Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { prompt, sessionId } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    try {
        console.log(`[GMAIL-AGENT] Request: "${prompt.slice(0, 80)}"`);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-opus-4-8',
                max_tokens: 2048,
                system: GMAIL_SYSTEM,
                messages: [{ role: 'user', content: prompt }],
                mcp_servers: [
                    {
                        type: 'url',
                        url: GMAIL_MCP_URL,
                        name: 'gmail-mcp',
                    }
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[GMAIL-AGENT] API error:', data);
            await notifyFailure({ route: '/api/gmail-agent', model: 'claude-opus-4-8', error: data?.error?.message, userMessage: prompt, sessionId });
            return res.status(502).json({ error: data?.error?.message || 'Gmail agent failed' });
        }

        // Extract text from response (may include mcp_tool_use blocks)
        const reply = (data?.content ?? [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim() || 'I checked your Gmail but could not retrieve a response.';

        console.log(`[GMAIL-AGENT] Success — ${reply.length} chars`);
        return res.status(200).json({ reply });

    } catch (err) {
        console.error('[GMAIL-AGENT] Error:', err);
        await notifyFailure({ route: '/api/gmail-agent', model: 'claude-opus-4-8', error: err, userMessage: prompt, sessionId });
        return res.status(500).json({ error: err.message });
    }
}
