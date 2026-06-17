// api/agent-log.js
// Returns the agent activity log from Redis
// Used by the frontend Agent tab to display what the agent learned

import { Redis } from '@upstash/redis';

export const maxDuration = 90;

const AGENT_LOG_KEY = 'hooda_agent:activity_log';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // POST: manually trigger background learning
  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'trigger_learn') {
      try {
        const secret = process.env.CRON_SECRET || 'hooda-cron-2026';
        // Create a mock req/res to call agent-learn handler directly
        const mockReq = {
          method:  'GET',
          headers: { 'authorization': `Bearer ${secret}` },
          query:   { secret },
        };
        let responseData = {};
        const mockRes = {
          status: (code) => ({
            json: (data) => { responseData = { code, ...data }; return mockRes; }
          }),
        };
        const { default: learnHandler } = await import('./agent-learn.js');
        await learnHandler(mockReq, mockRes);
        return res.status(200).json({ ok: true, triggered: true, result: responseData });
      } catch (err) {
        console.error('[AGENT-LOG] trigger_learn error:', err);
        return res.status(500).json({ error: err.message });
      }
    }
  }

  // GET: return activity log
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      return res.status(200).json({ entries: [], total: 0 });
    }

    const redis   = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    const raw     = await redis.lrange(AGENT_LOG_KEY, 0, 29); // last 30 entries
    const entries = raw.map(r => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);

    return res.status(200).json({ entries, total: entries.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
