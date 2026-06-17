// api/agent-log.js
// Returns the agent activity log from Redis
// Used by the frontend Agent tab to display what the agent learned

import { Redis } from '@upstash/redis';

export const maxDuration = 15;

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
        const res2   = await fetch(`${process.env.VERCEL_URL || 'https://www.yashhooda.ai'}/api/agent-learn`, {
          method:  'GET',
          headers: { 'Authorization': `Bearer ${secret}` },
        });
        const data = await res2.json();
        return res.status(200).json({ ok: true, triggered: true, result: data });
      } catch (err) {
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
