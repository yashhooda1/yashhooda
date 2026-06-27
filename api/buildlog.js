// api/buildlog.js
// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATED BUILD LOG — Gap 4: Ecosystem Fluency / Build in Public
// Reads from agent-learn Redis entries + manual entries
// Powers the /buildlog section on yashhooda.ai
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

export const maxDuration = 15;

const ALLOWED_ORIGINS = new Set([
  'https://yashhooda.ai',
  'https://www.yashhooda.ai',
  'https://yashhooda1.vercel.app',
]);

// ── STATIC SHIPPED MILESTONES (always shown, most recent first) ──────────────
const SHIPPED_MILESTONES = [
  {
    date:    '2026-06-27',
    title:   'Prompt Lab + LLM-as-Judge Eval Layer',
    body:    'Added systematic prompt engineering (zero-shot, few-shot, CoT, XML, role-based, extended thinking) with side-by-side comparison UI. Deployed LLM-as-judge scoring every chat response on helpfulness/accuracy/safety using claude-haiku.',
    tags:    ['prompt-engineering', 'evals', 'observability', 'ai-engineering'],
    type:    'feature',
    links:   [{ label: 'Live on yashhooda.ai', url: 'https://www.yashhooda.ai' }],
  },
  {
    date:    '2026-06-25',
    title:   '7-Layer AI Security Gateway — Production Hardened',
    body:    'Shipped IP reputation blocking (ASN + VPN detection), kill switch (Redis-backed), per-endpoint rate limiting, jailbreak detection (25+ patterns), content guard with auto-ban, file upload security (magic byte validation), and output filtering. Site survived active attacker campaign.',
    tags:    ['security', 'production', 'ai-engineering', 'infrastructure'],
    type:    'shipped',
    links:   [],
  },
  {
    date:    '2026-06-20',
    title:   'HoodaRunners Race Planner Agent — GCP Production',
    body:    'Deployed autonomous marathon training agent to Google Cloud Agent Runtime using Google ADK + Gemini 2.5 Flash. Fires 6 tools autonomously: Riegel predictor, pace zones, altitude adjuster (5,400 ft Boulder), race strategy builder, heat model, weekly plan generator.',
    tags:    ['agent', 'gcp', 'gemini', 'marathon', 'production'],
    type:    'shipped',
    links:   [
      { label: 'GitHub', url: 'https://github.com/yashhooda1/HoodaRunners-Race-Planner-Agent' },
      { label: 'Live Agent', url: 'https://hooda-race-planner.vercel.app/' },
    ],
  },
  {
    date:    '2026-06-15',
    title:   'Auth System — JWT + Email Verification + Stripe',
    body:    'Built full auth stack: JWT HS256 signed sessions, bcrypt password hashing, Resend email verification, password reset flow, 20 msg/month free tier enforcement, Stripe checkout for Pro ($5/month) and Supporter ($12/3 months) plans.',
    tags:    ['auth', 'stripe', 'saas', 'production'],
    type:    'shipped',
    links:   [],
  },
  {
    date:    '2026-06-10',
    title:   'Multi-Model LLM Registry — 11 Models Live',
    body:    'Shipped multi-provider model routing across Anthropic (Claude Opus/Sonnet), OpenAI (GPT-5.5/5.4/mini), xAI (Grok-3/mini), Google (Gemini 2.5 Flash/Pro), and Meta (Llama 4 Maverick, Llama 3.3 70B via Together.ai). Users can switch mid-conversation.',
    tags:    ['multi-model', 'routing', 'llm-registry', 'ai-engineering'],
    type:    'shipped',
    links:   [],
  },
  {
    date:    '2026-06-05',
    title:   'NBC Dashboard — 25 Franchise Locations Live',
    body:    'Shipped executive MIS dashboard for 25 Nothing Bundt Cakes locations (TX, NJ, CO). Toast POS → Microsoft Fabric Lakehouse (Bronze/Silver/Gold) via PySpark. Daily refresh via GitHub Actions. 8-tab Excel export with SheetJS. YoY comparison charts.',
    tags:    ['data-engineering', 'microsoft-fabric', 'pyspark', 'franchise', 'production'],
    type:    'shipped',
    links:   [{ label: 'Live Dashboard', url: 'https://nbc-dashboard.vercel.app/' }],
  },
  {
    date:    '2026-05-20',
    title:   'Hybrid RAG — Sparse + Dense Vectors + CRAG + Reranker',
    body:    'Upgraded RAG from basic dense retrieval to full hybrid (BM25 sparse + text-embedding-3-small dense) with RRF fusion, Corrective RAG (LLM quality scoring 1-5, auto web fallback, query rewriting), and cross-encoder reranker. Eval scores improved ~0.8 points on average.',
    tags:    ['rag', 'vector-db', 'upstash', 'retrieval', 'ai-engineering'],
    type:    'shipped',
    links:   [],
  },
  {
    date:    '2026-05-10',
    title:   'ClimatePulse — 55-Year NOAA Analytics Pipeline',
    body:    'Bronze→Silver→Gold pipeline for 55 years of NOAA daily station data (Houston IAH + Newark EWR). Key findings: Houston warming +0.805°F/decade, winter nights +1.005°F/decade. Auto-refreshes weekly via GitHub Actions + PAT secret.',
    tags:    ['data-engineering', 'climate', 'pipeline', 'medallion', 'python'],
    type:    'shipped',
    links:   [
      { label: 'GitHub', url: 'https://github.com/yashhooda1/climatepulse' },
      { label: 'Live Dashboard', url: 'https://www.yashhooda.ai/#climate' },
    ],
  },
];

// ── FORMAT AGENT-LEARN ENTRIES AS BUILD LOG ITEMS ────────────────────────────
function formatAgentEntry(entry) {
  try {
    const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
    if (!parsed?.timestamp) return null;
    const sources = parsed.sources || [];
    const findings = sources.flatMap(s => s.findings || []).slice(0, 3);
    return {
      date:    new Date(parsed.timestamp).toISOString().slice(0, 10),
      title:   `Agent Learn Cycle — ${sources.length} source${sources.length !== 1 ? 's' : ''} processed`,
      body:    findings.length
        ? findings.join(' • ')
        : 'Background learning cycle completed — knowledge base updated.',
      tags:    ['agent', 'learning', 'autonomous', 'rag'],
      type:    'agent',
      vectors: parsed.vectors || 0,
      elapsed: parsed.elapsed || null,
    };
  } catch { return null; }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Pull agent-learn entries from Redis ───────────────────────────────────
  let agentEntries = [];
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      const redis   = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      const raw     = await redis.lrange('hooda_agent_log', 0, 9);
      agentEntries  = (raw || []).map(formatAgentEntry).filter(Boolean);
    }
  } catch (err) {
    console.warn('[BUILDLOG] Redis fetch failed:', err.message);
  }

  // ── Merge and sort all entries ────────────────────────────────────────────
  const all = [...SHIPPED_MILESTONES, ...agentEntries]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30);

  // ── Stats summary ─────────────────────────────────────────────────────────
  const tagCounts = {};
  all.forEach(e => (e.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags   = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag]) => tag);

  return res.status(200).json({
    entries:      all,
    total:        all.length,
    topTags,
    lastUpdated:  new Date().toISOString(),
    generatedAt:  new Date().toISOString(),
  });
}
