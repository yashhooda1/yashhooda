// api/navigate.js — ES Module ("type":"module" in package.json)
// ══════════════════════════════════════════════════════════════════════════════
// AI NAVIGATOR — natural-language "where on this site is…?" for the ⌘K palette.
//
//   POST /api/navigate   { q: string, sections: [{id,title,group,hint}] }
//   → { target: "#id" | null, answer: string, alternates: ["#id"...], cached }
//
// The client sends its own live section index (so new sections never need a
// server change). The model picks the best destination and writes a one-line
// answer. Login-gated like every other paid endpoint; kill switch "navigate";
// per-IP rate limited; answers cached 6h per (query, index-version).
// ══════════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';
import { gate }      from '../lib/gateway.js';
import { rateLimit } from '../lib/rateLimit.js';
import { PROFILE }   from '../lib/profile.js';

import { FAST_MODEL } from '../lib/models.js';
export const maxDuration = 20;

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MODEL = FAST_MODEL /* was 'claude-haiku-4-5-20251001'; ANTHROPIC_FAST_MODEL=claude-haiku-5-5 upgrades */;

export default async function handler(req, res) {
    const g = await gate(req, res, { endpoint: 'navigate', methods: ['POST'], auth: 'user' });
    if (!g.ok) return;

    const allowed = await rateLimit(req, res, { endpoint: 'navigate', maxPerMinute: 10, maxPerHour: 60, maxDailyGlobal: 600 });
    if (!allowed) return;

    const q = String(req.body?.q || '').trim().slice(0, 300);
    const sections = (Array.isArray(req.body?.sections) ? req.body.sections : [])
        .slice(0, 80)
        .map(s => ({
            id:    String(s.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40),
            title: String(s.title || '').slice(0, 80),
            group: String(s.group || '').slice(0, 40),
            hint:  String(s.hint || '').slice(0, 160),
        }))
        .filter(s => s.id && s.title);

    if (q.length < 2) return res.status(400).json({ error: 'query_too_short' });
    if (!sections.length) return res.status(400).json({ error: 'no_index' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'service_unavailable' });

    const indexVersion = createHash('sha1').update(sections.map(s => s.id).join('|')).digest('hex').slice(0, 10);
    const key = `navigate:${indexVersion}:${createHash('sha1').update(q.toLowerCase()).digest('hex').slice(0, 24)}`;
    try {
        const cached = await redis.get(key);
        if (cached) return res.status(200).json({ ...(typeof cached === 'string' ? JSON.parse(cached) : cached), cached: true });
    } catch (e) { /* cache miss on error */ }

    const list = sections.map(s => `- #${s.id} | ${s.title}${s.group ? ` | group: ${s.group}` : ''}${s.hint ? ` | ${s.hint}` : ''}`).join('\n');
    const system = `You route visitors of yashhooda.ai (Yash Hooda's engineering portfolio) to the right section of the page, and answer briefly from the profile when the question is about Yash himself.

SECTIONS ON THE PAGE (id | title | group | hint):
${list}

PROFILE (for short factual answers only):
${PROFILE.slice(0, 3500)}

Rules: pick the single best section id for the visitor's request, or null if nothing fits. The answer is ONE friendly sentence (≤ 30 words) that answers the question or says what they'll find there. Up to 2 alternates. Never invent sections. Respond with ONLY JSON: {"target": "#id" | null, "answer": "...", "alternates": ["#id", ...]}`;

    let out = null;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body:    JSON.stringify({ model: MODEL, max_tokens: 220, temperature: 0, system, messages: [{ role: 'user', content: q }] }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || `anthropic ${r.status}`);
        const m = String(data?.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
        out = m ? JSON.parse(m[0]) : null;
    } catch (e) {
        console.error('[navigate] model call failed:', e.message);
        return res.status(502).json({ error: 'model_error', message: 'Navigator is unavailable right now.' });
    }

    const valid = new Set(sections.map(s => `#${s.id}`));
    const result = {
        target:     valid.has(out?.target) ? out.target : null,
        answer:     String(out?.answer || '').slice(0, 240),
        alternates: (Array.isArray(out?.alternates) ? out.alternates : []).filter(a => valid.has(a)).slice(0, 2),
        model:      MODEL,
        cached:     false,
    };
    try { await redis.set(key, JSON.stringify(result), { ex: 60 * 60 * 6 }); } catch (e) { /* ignore */ }
    return res.status(200).json(result);
}
