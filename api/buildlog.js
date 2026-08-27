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
    date:    '2026-08-27',
    title:   'Running Coach SFT — Fine-Tuned a 3B and Measured What It Didn\'t Learn',
    body:    'Published a 1,527-example running-coaching corpus where every pace is computed from a Daniels/Gilbert VDOT implementation rather than typed into a template, then fine-tuned Qwen2.5-3B on it and built an eval that scores whether prescribed paces actually follow from the athlete\'s fitness. Because the numbers are generated, the corpus itself scores 0.0% off-zone — a verified floor. The base model was 47.3%. The fine-tune learned the format almost perfectly (pace density 349 → 1,242 against a ground truth of 1,066; on one task it matched the reference exactly, 60 for 60) and the arithmetic barely at all: 39.3% off-zone, with three of five tasks getting worse. Training loss hit 0.07 at 96.7% token accuracy, so it isn\'t undertrained — validation loss looked excellent the whole way and would have read as success without an eval measuring the numbers directly. Six years of my own Strava history replaced the generator\'s invented constants; the heat rule didn\'t survive, coming out at 0.235 s/mi per °F at matched heart rate against the 15–20 s/mi rule of thumb, with year fixed effects doing the load-bearing work. One row of the results table is my metric being wrong rather than the model, and it\'s documented as such. The negative result is the point: it\'s the measured case for PaceForge\'s design decision that the LLM is the interface, not the reasoning engine.',
    tags:    ['fine-tuning', 'lora', 'peft', 'evals', 'synthetic-data', 'huggingface', 'running', 'negative-results'],
    type:    'shipped',
    links:   [
      { label: 'GitHub',  url: 'https://github.com/yashhooda1/running-coach-dataset' },
      { label: 'Dataset', url: 'https://huggingface.co/datasets/hoodarunner/running-coach-sft' },
      { label: 'Model',   url: 'https://huggingface.co/hoodarunner/running-coach-qwen3b-lora' },
    ],
   },
   {
    date:    '2026-08-25',
    title:   'Pace Calculator + Race Time by Temperature',
    body:    'Two more running tools on the site. The pace calculator solves for whichever of pace, time, or distance you leave out, and reports the result six ways plus race times from 400m to the marathon. The interesting one is the inverse: give it a result and the conditions you ran it in, and it strips the heat penalty back out to recover the cool-air performance underneath, then re-applies it anywhere else — an 18:15 5K at 85°F with a 74°F dew point is a 17:18 in cool air. Output is a temp × dew matrix of predicted finishes, color-coded by severity zone, with your actual conditions outlined. Added a duration factor to the shared model (0.86× at 18 minutes, 1.0× at 60, 1.13× at three hours) because heat compounds with time on your feet — a marathon bleeds far more to a hot day than a 5K does — and backported it to the heat-adjusted pace tool so both read from one model. Round-trip is exact: feed the original conditions back in and the original time comes out.',
    tags:    ['running', 'weather', 'modeling', 'vanilla-js', 'tools'],
    type:    'shipped',
    links:   [
      { label: 'Pace Calculator', url: 'https://www.yashhooda.ai/#pace-calc' },
      { label: 'Race Time by Temperature', url: 'https://www.yashhooda.ai/#heat-equivalent' },
    ],
  },
  {
    date:    '2026-08-23',
    title:   'Heat-Adjusted Pace — Live METAR Conditions',
    body:    'Shipped a heat-adjusted pace tool that answers the Houston summer question: what should today actually cost me? Temperature plus dew point interpolated across the standard heat-pace bands, scaled by effort, with a severity gauge and a table of how the answer moves if the forecast shifts. The part I cared about was the input: instead of asking the runner to look up the dew point, a serverless endpoint pulls the live observation from the same NOAA METAR feed behind METAR Stream and fills both fields — Upstash-cached at a 5-minute TTL, degrading to manual entry if the feed is unreachable. Zero dependencies, no build step, scoped CSS, one drop-in section.',
    tags:    ['running', 'weather', 'metar', 'noaa', 'serverless', 'vercel'],
    type:    'shipped',
    links:   [
      { label: 'Live on yashhooda.ai', url: 'https://www.yashhooda.ai/#heat-pace' },
    ],
  },
  {
    date:    '2026-08-22',
    title:   'PaceForge — Offline AI Running Coach with Garmin + Strava MCP',
    body:    'Shipped a running coach that runs entirely on a local model — no API keys, no cloud inference, training data never leaves the machine. The design decision: the LLM is the interface, not the reasoning engine. VDOT, Banister TRIMP, EWMA acute:chronic workload ratio, and 5K periodisation are deterministic unit-tested functions; the model only selects tools and explains results, so every recommendation traces to a named threshold rather than a black box. Two MCP servers (Garmin: 7 tools including structured-workout writes; Strava: 6 read/analysis), hybrid dense+BM25 RAG over a running-science corpus, 289 tests, mypy --strict, CI across Linux/macOS/Windows with a smoke job that proves the offline claim by running the full pipeline with no model, no credentials, and no network.',
    tags:    ['mcp', 'local-llm', 'ollama', 'offline-ai', 'agent', 'garmin', 'strava', 'testing'],
    type:    'shipped',
    links:   [
      { label: 'GitHub', url: 'https://github.com/yashhooda1/paceforge' },
      { label: 'Ollama Model', url: 'https://ollama.com/hoodarunner/paceforge-coach' },
    ],
  },
  {
    date:    '2026-07-12',
    title:   'SLM Offline Agent — Local ReAct Loop, No API Key',
    body:    'A fully offline ReAct agent running on a local small language model: no API key, no network calls, no framework. The reasoning loop is hand-written rather than inherited from LangChain, so every thought → action → observation step is inspectable instead of buried in an abstraction — which is exactly what you need when the model is small enough to reason badly. Six sandboxed tools, a stdlib-only SSE server, and content guardrails on the output path. The test suite runs green with no model loaded, so CI validates the agent control flow independently of whatever the model happens to say that day.',
    tags:    ['agent', 'react', 'local-llm', 'ollama', 'offline-ai', 'python', 'testing', 'guardrails'],
    type:    'shipped',
    links:   [
      { label: 'Ollama Model', url: 'https://ollama.com/hoodarunner/offline-agent' },
    ],
  },
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
