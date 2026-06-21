// api/usage.js
// Returns current usage stats for a session — used by frontend to show the
// usage counter and upgrade prompt in the chat widget.

import { getUsage } from '../lib/usageLimit.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const usage = await getUsage(sessionId);
    return res.status(200).json(usage);
}
