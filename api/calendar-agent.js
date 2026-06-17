// api/calendar-agent.js
// Google Calendar integration via MCP
// Handles: read events, check availability, create events

import { notifyFailure } from './_notify.js';

export const maxDuration = 30;

const CALENDAR_MCP_URL = 'https://calendarmcp.googleapis.com/mcp/v1';

const CALENDAR_SYSTEM = `You are Yash Hooda's personal Google Calendar assistant.
You have access to Google Calendar via MCP tools.
For read requests: list events clearly with time, title, location, and attendees if present.
For availability checks: check the calendar and give a clear yes/no with context.
For create requests: confirm the details with the user before creating — show what you'll create and ask "Should I add this to your calendar?"
Format times in Central Time (Houston, TX — CST/CDT).
Format all responses in clean markdown. Be concise.
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
        console.log(`[CALENDAR-AGENT] Request: "${prompt.slice(0, 80)}"`);

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
                system: CALENDAR_SYSTEM,
                messages: [{ role: 'user', content: prompt }],
                mcp_servers: [
                    {
                        type: 'url',
                        url: CALENDAR_MCP_URL,
                        name: 'calendar-mcp',
                    }
                ],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[CALENDAR-AGENT] API error:', data);
            await notifyFailure({ route: '/api/calendar-agent', model: 'claude-opus-4-8', error: data?.error?.message, userMessage: prompt, sessionId });
            return res.status(502).json({ error: data?.error?.message || 'Calendar agent failed' });
        }

        const reply = (data?.content ?? [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim() || 'I checked your calendar but could not retrieve a response.';

        console.log(`[CALENDAR-AGENT] Success — ${reply.length} chars`);
        return res.status(200).json({ reply });

    } catch (err) {
        console.error('[CALENDAR-AGENT] Error:', err);
        await notifyFailure({ route: '/api/calendar-agent', model: 'claude-opus-4-8', error: err, userMessage: prompt, sessionId });
        return res.status(500).json({ error: err.message });
    }
}
