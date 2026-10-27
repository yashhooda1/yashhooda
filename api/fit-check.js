// api/fit-check.js — ES Module ("type":"module" in package.json)
// ══════════════════════════════════════════════════════════════════════════════
// FIT CHECK — paste a job description, get an honest AI fit report for Yash.
//
//   POST /api/fit-check   { jd: string, adminPassword?: string }
//   → { score, verdict, headline, strengths[], gaps[], pitch, questions[],
//       keywords: { hits[], misses[] }, cached, model }
//
// Gating (matches the site's security rules — no paid endpoint without login):
//   • gate(): JWT required, verified email, origin check, kill switch "fit-check"
//   • rateLimit(): per-IP minute/hour + global daily cap
//   • guardRequest(): content screen + strike tracking
//   • 24h Redis cache keyed on a hash of the JD (same JD → no second LLM call)
//
// Honesty design: the deterministic keyword scan runs FIRST and the model is
// told which skills are known gaps, so it cannot bluff "yes, 5 years of
// Terraform". Score blends the model's judgement with the keyword coverage.
// Kill switch: SET killswitch:fit-check on
// ══════════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';
import { gate }         from '../lib/gateway.js';
import { rateLimit }    from '../lib/rateLimit.js';
import { guardRequest } from '../lib/contentGuard.js';
import { PROFILE, scanKeywords } from '../lib/profile.js';

import { FAST_MODEL } from '../lib/models.js';
export const maxDuration = 45;

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MODEL     = FAST_MODEL /* was 'claude-haiku-4-5-20251001'; ANTHROPIC_FAST_MODEL=claude-haiku-5-5 upgrades */;
const MAX_JD    = 12000;
const MIN_JD    = 80;
const CACHE_TTL = 60 * 60 * 24;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function extractJson(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

export default async function handler(req, res) {
    const g = await gate(req, res, { endpoint: 'fit-check', methods: ['POST'], auth: 'user' });
    if (!g.ok) return;

    const allowed = await rateLimit(req, res, { endpoint: 'fit-check', maxPerMinute: 4, maxPerHour: 20, maxDailyGlobal: 300 });
    if (!allowed) return;

    const jd = String(req.body?.jd || '').trim();
    if (jd.length < MIN_JD) return res.status(400).json({ error: 'jd_too_short', message: 'Paste the full job description (at least a few sentences).' });
    if (jd.length > MAX_JD) return res.status(413).json({ error: 'jd_too_long', message: `Job description is too long (max ${MAX_JD} characters).` });

    const guard = await guardRequest(req, g.user, jd, { isAdmin: g.isAdmin });
    if (!guard.ok) return res.status(guard.status).json(guard.body);

    const keywords = scanKeywords(jd);
    const key = `fitcheck:${createHash('sha256').update(jd).digest('hex').slice(0, 32)}`;

    try {
        const cached = await redis.get(key);
        if (cached) return res.status(200).json({ ...(typeof cached === 'string' ? JSON.parse(cached) : cached), cached: true });
    } catch (e) { console.warn('[fit-check] cache read failed:', e.message); }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'service_unavailable', message: 'Fit Check is not configured.' });

    const gapNote = keywords.misses.length
        ? `The following skills appear in the JD but Yash has NO strong evidence for them — list them as gaps, never claim them: ${keywords.misses.join(', ')}.`
        : 'No obvious hard-skill gaps were detected by the keyword scan; still look for seniority, domain or leadership gaps.';

    const system = `You are a rigorous, fair technical recruiter evaluating ONE candidate against a job description. Use ONLY the candidate profile below as evidence. Be concrete: cite the specific project or role that proves each strength. Be honest about gaps — the candidate prefers a true 62 over a flattering 90. Never invent experience, employers, years, or credentials. If the JD requires something not in the profile, it is a gap. Years-of-experience requirements above ~2 years are a partial gap: say so plainly and note the production work that offsets it.

CANDIDATE PROFILE
${PROFILE}

${gapNote}

Respond with ONLY a JSON object (no markdown fences) of this exact shape:
{
  "score": <integer 0-100, overall fit>,
  "verdict": <"Strong fit" | "Good fit" | "Partial fit" | "Stretch" | "Weak fit">,
  "headline": <one sentence, ≤ 25 words, the honest summary a recruiter would say out loud>,
  "role_title": <the job title as written in the JD, or "" if absent>,
  "company": <company name if present in the JD, else "">,
  "strengths": [<3-6 short bullets, each naming the proof (project/role)>],
  "gaps": [<2-5 short bullets; include seniority/domain/visa-style gaps if the JD states them>],
  "pitch": <3-4 sentences in first person as Yash, tailored to THIS role, no fluff, mentions 2 concrete shipped systems>,
  "questions": [<3 sharp questions Yash should ask the hiring manager about this specific role>]
}`;

    let out;
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body:    JSON.stringify({
                model: MODEL, max_tokens: 1400, temperature: 0.2,
                system,
                messages: [{ role: 'user', content: `JOB DESCRIPTION:\n\n${jd}` }],
            }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || `anthropic ${r.status}`);
        out = extractJson(data?.content?.[0]?.text);
    } catch (e) {
        console.error('[fit-check] model call failed:', e.message);
        return res.status(502).json({ error: 'model_error', message: 'The fit analysis could not be completed right now. Try again in a minute.' });
    }
    if (!out) return res.status(502).json({ error: 'bad_model_output', message: 'The model returned something unexpected. Try again.' });

    // Blend: 75% model judgement, 25% deterministic keyword coverage (so a JD
    // full of skills he has never touched cannot score 90 on vibes).
    const totalKw = keywords.hits.length + keywords.misses.length;
    const coverage = totalKw ? keywords.hits.length / totalKw : 0.7;
    const modelScore = clamp(Number(out.score) || 0, 0, 100);
    const score = Math.round(clamp(0.75 * modelScore + 25 * coverage, 0, 100));

    const result = {
        score,
        model_score: modelScore,
        verdict:    String(out.verdict || (score >= 80 ? 'Strong fit' : score >= 65 ? 'Good fit' : score >= 50 ? 'Partial fit' : score >= 35 ? 'Stretch' : 'Weak fit')),
        headline:   String(out.headline || '').slice(0, 300),
        role_title: String(out.role_title || '').slice(0, 120),
        company:    String(out.company || '').slice(0, 120),
        strengths:  (Array.isArray(out.strengths) ? out.strengths : []).slice(0, 6).map(s => String(s).slice(0, 220)),
        gaps:       (Array.isArray(out.gaps) ? out.gaps : []).slice(0, 5).map(s => String(s).slice(0, 220)),
        pitch:      String(out.pitch || '').slice(0, 1200),
        questions:  (Array.isArray(out.questions) ? out.questions : []).slice(0, 3).map(s => String(s).slice(0, 220)),
        keywords,
        model:      MODEL,
        generated_at: new Date().toISOString(),
        cached:     false,
    };

    try { await redis.set(key, JSON.stringify(result), { ex: CACHE_TTL }); } catch (e) { console.warn('[fit-check] cache write failed:', e.message); }
    return res.status(200).json(result);
}
