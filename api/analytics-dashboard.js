// api/analytics-dashboard.js
// Read-only endpoint — returns chatbot usage stats from Redis
// for the Analytics tab in the chat window.
// No writes happen here; all data is written by chat.js trackAnalytics().

import { Redis } from "@upstash/redis";

export const maxDuration = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(200).json({ error: 'Redis not configured', days: [], questions: [], totals: {} });
  }

  try {
    const redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // ── Build last-7-day key list ──
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayKeys.push(`hooda_analytics:${d.toISOString().slice(0, 10)}`);
    }

    // ── Fetch all day hashes + question log in parallel ──
    const [dayData, rawQuestions] = await Promise.all([
      Promise.all(dayKeys.map(k => redis.hgetall(k).catch(() => null))),
      redis.lrange('hooda_analytics:questions', 0, 49).catch(() => []),
    ]);

    // ── Shape per-day stats ──
    const days = dayKeys.map((key, i) => {
      const h = dayData[i] || {};
      const date       = key.split(':')[1];
      const total      = parseInt(h.total_requests    || 0);
      const success    = parseInt(h.retrieval_success || 0);
      const fallbacks  = parseInt(h.web_fallbacks     || 0);
      const totalMs    = parseInt(h.total_response_ms || 0);
      return {
        date,
        total_requests:      total,
        retrieval_success:   success,
        retrieval_success_pct: total > 0 ? Math.round((success / total) * 100) : 0,
        web_fallbacks:       fallbacks,
        web_fallback_pct:    total > 0 ? Math.round((fallbacks / total) * 100) : 0,
        avg_response_ms:     total > 0 ? Math.round(totalMs / total) : 0,
        agent_running:       parseInt(h.agent_running || 0),
        agent_career:        parseInt(h.agent_career  || 0),
        agent_travel:        parseInt(h.agent_travel  || 0),
        agent_general:       parseInt(h.agent_general || 0),
      };
    });

    // ── 7-day totals ──
    const totals = days.reduce((acc, d) => ({
      total_requests:    acc.total_requests    + d.total_requests,
      retrieval_success: acc.retrieval_success + d.retrieval_success,
      web_fallbacks:     acc.web_fallbacks     + d.web_fallbacks,
      total_ms:          acc.total_ms          + (d.avg_response_ms * d.total_requests),
      agent_running:     acc.agent_running     + d.agent_running,
      agent_career:      acc.agent_career      + d.agent_career,
      agent_travel:      acc.agent_travel      + d.agent_travel,
      agent_general:     acc.agent_general     + d.agent_general,
    }), { total_requests:0, retrieval_success:0, web_fallbacks:0, total_ms:0,
          agent_running:0, agent_career:0, agent_travel:0, agent_general:0 });

    totals.retrieval_success_pct = totals.total_requests > 0
      ? Math.round((totals.retrieval_success / totals.total_requests) * 100) : 0;
    totals.web_fallback_pct = totals.total_requests > 0
      ? Math.round((totals.web_fallbacks / totals.total_requests) * 100) : 0;
    totals.avg_response_ms = totals.total_requests > 0
      ? Math.round(totals.total_ms / totals.total_requests) : 0;

    // ── Parse recent questions ──
    const questions = (rawQuestions || []).map(q => {
      try { return typeof q === 'string' ? JSON.parse(q) : q; } catch { return null; }
    }).filter(Boolean).slice(0, 20);

    return res.status(200).json({ days, totals, questions });

  } catch (err) {
    console.error('analytics-dashboard error:', err);
    return res.status(500).json({ error: 'Failed to load analytics' });
  }
}
