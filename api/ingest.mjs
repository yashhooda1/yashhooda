/**
 * scripts/ingest.mjs
 * Run ONCE locally to (re)seed your Upstash Vector index with Yash's portfolio content.
 * Aviation-forward: leads with the pilot journey, engineering as the foundation.
 *
 * Oct 2026 UPDATE: the chunks that get ingested are now `currentChunks` (engineering-
 * forward, Austin-based, 2027 Aramco Half + lifelong sub-3 goal). The original
 * `legacyChunks` below are kept verbatim for history and are ONLY ingested when
 * INCLUDE_LEGACY=1 — several of them (airline-pilot framing, Boulderthon) contradict
 * the current facts and would poison retrieval. Each chunk is upserted with BOTH a
 * dense OpenAI embedding and the same hashed sparse vector api/chat.js queries with,
 * so hybrid (dense + sparse, RRF) retrieval actually gets sparse hits now.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... \
 *   UPSTASH_VECTOR_REST_URL=https://... \
 *   UPSTASH_VECTOR_REST_TOKEN=... \
 *   node scripts/ingest.mjs
 *
 * NOTE: this script RESETS the index first (clears old/stale chunks) and then
 * re-ingests everything below. To skip the reset (pure upsert), set SKIP_RESET=1.
 */

import { Index } from "@upstash/vector";

// ── KNOWLEDGE CHUNKS ──
// Each chunk is an independent piece of knowledge the chatbot can retrieve.
// Add, edit, or remove chunks here freely — the script resets + re-ingests, so
// removals actually take effect (no stale leftovers).
const legacyChunks = [
  {
    id: "bio",
    text: "Yash Hooda is a 24-year-old training to become an airline pilot, based in the Houston area (Richmond, Texas). He is enrolled in ATP Flight School's Airline Career Pilot Program at Sugar Land Regional Airport (SGR), working toward his Private Pilot Certificate, with the goal of flying for United Airlines through the Aviate program. He came to aviation from a career as an AI & Data Engineer (BS Computer Science, UT Dallas) — the engineering work funds his flight training and remains a genuine strength. Lifelong interests: aviation, weather, running, astronomy, hiking, and travel.",
  },
  {
    id: "aviation-journey",
    text: "Aviation status (accurate — do not overstate): Yash is a student pilot at the very start of training. About 1 flight hour logged; formal training begins August 3, 2026 at ATP Flight School (Sugar Land Regional, SGR) in the Airline Career Pilot Program. He is currently working toward his Private Pilot Certificate (PPL). Rating roadmap: PPL → Instrument → Commercial → Multi-Engine → CFI → CFII/MEI → build to 1,500 hours / ATP → regional airline First Officer → major airline. Target: United Airlines via the United Aviate program. Through ATP's Career Track to United, he can interview with Aviate once he earns his PPL, and acceptance brings a conditional First Officer offer. He is NOT yet accepted into Aviate — it is the goal, not a current status. The first-class medical certificate is the gating health check on this path.",
  },
  {
    id: "aviation-why",
    text: "Why aviation: Yash has a lifelong pull toward flight and weather. He sees the cockpit as rewarding the same instincts as engineering — discipline, systems thinking, checklists, and reliability under real constraints. His weather and climate work is a genuine asset, since reading weather (METARs, TAFs, winds aloft, density altitude, convective weather) is a core pilot skill. He also builds aviation tools, including the Infinite Flight Live Tracker and a live flight tracker on his website.",
  },
  {
    id: "infinite-flight",
    text: "Infinite Flight simulator profile (flight-sim experience, NOT real logged flight hours): Yash flies as 'Yash_Hooda' on Infinite Flight's Expert Server, a member since 2019. Stats: Grade 3, about 1,367 hours of simulator flight time, 653 online flights, 242 landings, 859,750 XP. This is simulator time — not real logged flight time — but the airmanship, procedures, and live ATC communications carry over to real training.",
  },
  {
    id: "engineering-foundation",
    text: "Engineering background (the foundation funding the flying): Yash is an AI & Data Engineer. Data Engineering: PySpark, Databricks, Microsoft Fabric, SQL, Delta Lake, ETL/ELT, medallion architecture. AI/ML: OpenAI & Anthropic APIs, LangChain, RAG, vector databases, prompt engineering, model fine-tuning, FastAPI. Primary language Python. He has built full-stack AI and data systems that run in production on real traffic.",
  },
  {
    id: "certifications",
    text: "Yash holds 5 certifications: Databricks Certified Data Engineer Associate, IBM AI Engineering Professional Certificate, IBM Data Science Professional Certificate, Vanderbilt University AI Prompt Engineering Professional Certificate, and Microsoft Certified Power Platform Fundamentals.",
  },
  {
    id: "project-if-tracker",
    text: "Infinite Flight Live Tracker: a real-time flight tracker for the Infinite Flight simulator. Live map of every aircraft on a server (coloured by flight phase), origin→destination cards with live ETAs, arrival weather + 5-day forecast, satellite/day-night layers, ATC frequencies, and pilot logbooks. A FastAPI backend proxies and caches the Live API so keys never touch the browser. Tech: Python, FastAPI, Leaflet, OpenWeather, Render. GitHub: github.com/yashhooda1/IF-Flight-Tracker.",
  },
  {
    id: "project-climatepulse",
    text: "ClimatePulse: a 56-year (1970–2026) NOAA climate analytics pipeline across 13 global cities (Houston, Newark, Dallas, Denver, London, Helsinki, Amsterdam, Brussels, Paris, Rome, Chicago, Los Angeles, Delhi). Bronze→Silver→Gold medallion architecture with automated daily refresh via GitHub Actions. Headline finding: Houston warming about +0.77°F/decade. Denver is included for Boulderthon marathon race-planning context. Tech: Python, pandas, scikit-learn, NOAA API, GitHub Actions. GitHub: github.com/yashhooda1/climatepulse. Weather/climate work also supports his aviation goals.",
  },
  {
    id: "project-hoodaroutes",
    text: "HoodaRoutes (routes.yashhooda.ai): a worldwide running-route generator. Road-snapped loops calibrated to a target distance via OpenRouteService, personalized to a runner's Strava history, with one-tap push to Garmin and a companion Connect IQ watch app sideloaded onto a Forerunner 970. Tech: Next.js/Vercel, Node, FastAPI, Strava OAuth, Upstash Redis, Railway, Garmin Connect IQ.",
  },
  {
    id: "project-garmin-mcp",
    text: "Garmin MCP Server (mcp-garmin): a Model Context Protocol server that lets Claude read Garmin activities and build and schedule structured workouts and full training plans straight to a Garmin watch. Reverse-engineered Garmin's workout-service schema into a typed, LLM-friendly spec, with garth SSO auth, a bearer-secured HTTP transport, an offline test suite, and CI, packaged for Docker/Railway. Tech: Python, MCP, FastMCP, Pydantic, garminconnect/garth, Docker. GitHub: github.com/yashhooda1/mcp-garmin.",
  },
  {
    id: "project-hoodahiring",
    text: "hoodahiring.ai: an LLM resume-intelligence app that parses resumes into structured candidate data and scores fit against a live job description. Containerized and deployed on Railway with a custom domain. Tech: Python, Docker, multi-provider LLM (OpenAI/Anthropic).",
  },
  {
    id: "running-prs",
    text: "Yash's running personal records: Mile — 4:58; 5K — 18:15 (2025 Women's Quarter Marathon, Houston, ~5:53/mi); 5-Mile — 30:22 (2025 Sugar Land Turkey Trot, ~6:04/mi); 8K — 29:48 (2025 Sugar Land Turkey Trot, ~5:59/mi); Half Marathon — 1:24:31 (2025 Aramco Houston Half, ~6:27/mi). Last race: 2026 NYCRuns Brooklyn Experience Half in 1:27:41. Marathon PR: TBD, currently in training.",
  },
  {
    id: "running-training",
    text: "Yash runs about 30–40 miles per week, training for the 2026 Boulderthon Marathon (Boulder, CO, September 27, 2026) and targeting a sub-3:00 marathon and a big PR at the 2027 Chevron Houston Marathon (January 17, 2027). He trains using the 80/20 rule (80% easy, 20% hard: tempo, intervals, long runs) and manages high volume in the Houston heat.",
  },
  {
    id: "career-aviation-path",
    text: "Aviation career path advice: the fastest structured route is an accelerated program like ATP's Airline Career Pilot Program — roughly zero time to Commercial + CFI in 9–12 months, then instruct to build hours toward the 1,500-hour ATP minimum. Ratings order: PPL → Instrument → Commercial → Multi-Engine → CFI/CFII/MEI → build hours instructing → R-ATP/ATP → regional First Officer → major airline. Airline pipelines like United Aviate let you interview after earning your PPL for a conditional offer. Get a first-class medical EARLY — it is the true gate; clear it before committing large money. Budget realistically (accelerated training runs well into six figures) and plan a financial runway. Network with CFIs and airline recruiters and keep a clean logbook.",
  },
  {
    id: "career-engineering-path",
    text: "Engineering career advice (Yash's foundation): You do not need a master's to break into AI/Data Engineering — certifications + deployed projects + consistency win. Data path: SQL → Python → one cloud → Spark/Databricks; learn dbt, Airflow, Kafka, Delta Lake. AI path: Python → ML basics → deep learning → LLMs + RAG + prompt engineering → agents → deployment (FastAPI). Build in public (GitHub + LinkedIn), get one real project deployed, and freelance (Upwork, Alignerr, Outlier.AI) to build a track record.",
  },
  {
    id: "weather-climate",
    text: "Weather & climate: Yash is deeply interested in weather and climate, which dovetails with aviation since weather is central to flight planning and safety. His site has a live weather widget (Open-Meteo) and several climate/weather dashboards: ClimatePulse (13-city climate pipeline), Atlantic hurricane analytics, a rising-seas / coastal-risk dashboard, and an AI-data-center energy & water footprint dashboard — all with honest, sourced framing.",
  },
  {
    id: "life-balance",
    text: "Yash balances flight training, engineering work, running 30–40 miles/week, and time with family and friends. Strategies: protect run time like a meeting (morning or evening), treat weekend long runs as non-negotiable, Sunday meal prep, match hardest efforts to highest-energy days, 30–60 min/day of focused building over sporadic marathon sessions, and 8–9 hours of sleep as the #1 performance lever. Recovery and true rest days prevent burnout.",
  },
  {
    id: "contact",
    text: "Contact Yash: Email yash.hooda6@gmail.com, LinkedIn linkedin.com/in/yash-hooda-384430242, GitHub github.com/yashhooda1, Upwork upwork.com/freelancers/~01d69d754fc4bf488e, YouTube youtube.com/@hoodarunner, Linktree linktr.ee/hooda_yash1, Strava strava.com/athletes/89409717.",
  },
];

// ── CURRENT KNOWLEDGE CHUNKS (Oct 2026) ──────────────────────────────────────
const currentChunks = [
  { id: "bio-2026", text: "Yash Hooda is a Data Engineer and AI Engineer based in Austin, Texas (he moved from Richmond, TX in the Houston area in October 2026). BS in Computer Science from the University of Texas at Dallas (May 2024). Databricks Certified Data Engineer Associate. He builds and operates production AI systems and real-time data pipelines, and is open to Data Engineering and AI Engineering roles, full-time or contract. Contact: yash.hooda6@gmail.com. Website: yashhooda.ai." },
  { id: "aviation-hobby-2026", text: "Aviation is a hobby for Yash, not a career path: he flies small planes part-time for fun and is slowly working toward a private pilot certificate, and he flies on the Infinite Flight simulator (Expert Server) as Yash_Hooda. He is NOT training to become an airline pilot. His aviation interest shows up in his engineering work instead: the METAR Stream aviation-weather pipeline, the Infinite Flight live tracker, and the flight log section of his site." },
  { id: "engineering-skills-2026", text: "Yash's engineering stack. Data engineering: PySpark, Databricks, Microsoft Fabric, SQL (T-SQL, Spark SQL), Delta Lake, ETL/ELT, medallion Bronze/Silver/Gold architecture, Spark Structured Streaming, Kafka/Redpanda, watermarking and event-time dedupe, checkpointing, data quality and reconciliation, incremental caching, pipelines scheduled on GitHub Actions. AI engineering: Anthropic and OpenAI APIs, multi-model routing (Claude, GPT, Gemini, Grok, Llama), LangChain/LangGraph, hybrid RAG (dense + sparse, RRF fusion, CRAG grading, cross-encoder reranking), Upstash Vector, FAISS, Chroma, agentic ReAct loops, MCP servers, QLoRA/LoRA fine-tuning, eval harnesses with golden sets, Ollama local inference, Azure OpenAI and Azure Document Intelligence. Platform: Node.js, Python, FastAPI, Vercel serverless, Railway, Render, Docker, Redis/Upstash, Stripe, JWT auth, rate limiting, kill switches. Apple: SwiftUI, watchOS, Siri Shortcuts, Apple Health." },
  { id: "experience-2026", text: "Yash's work experience: GSR Group (multi-unit restaurant franchise, 25 locations) — Data Engineer contract, March–July 2026, owned the Toast POS ingestion pipeline. Ternio Group (healthcare supply chain) — built Microsoft Fabric ML models for document extraction on surgical-instrument records from vendors such as Stryker. Archrock (energy, natural-gas compression) and CIMCO (manufacturing, aerospace-adjacent) — data engineering contracts. Outlier AI — AI/ML data specialist. 2026: SLTX AI policy-data extractor using Azure OpenAI and Document Intelligence. Since 2025 he has independently built, deployed and operated the systems on yashhooda.ai." },
  { id: "project-hoodaagents-2026", text: "HoodaAgents is the AI platform built into yashhooda.ai: a multi-model agentic assistant (Claude Opus/Sonnet/Haiku 5.5, Claude Fable 5.1, GPT-6.x, GPT-5.x, Gemini 4 and 3.x, Grok 4.x, Llama) with hybrid RAG over Upstash Vector (dense + sparse retrieval, RRF fusion, CRAG grading, cross-encoder reranking), per-session Redis memory, voice input and TTS output, image and file analysis, a code agent, a Prompt Lab for comparing prompting strategies, a running agent with Strava tools, a self-improving agent-learn loop, an offline eval harness with a golden set, Stripe-gated free/Pro tiers, admin kill switches, and a 7-layer security gateway (rate limiting, content guards, jailbreak detection, IP reputation, kill switch, JWT auth, origin checks) that held through a real attack campaign." },
  { id: "project-metar-stream-2026", text: "METAR Stream: Yash's real-time aviation weather pipeline — Kafka (Redpanda) into Spark Structured Streaming writing a Bronze→Silver→Gold Delta Lake medallion over roughly 1,100 North American airport stations, with low-visibility and high-gust alert streams, watermarking, event-time deduplication, per-sink checkpointing and offset-throttled backpressure. Measured over 25.6 hours: 240,997 raw messages, 10,018 observations retained after dedupe, zero duplicate keys, and a 181-second broker outage survived. Lessons: the upstream API silently truncates at 400 results; partitioning silver by station produced 2,364 tiny Parquet files for 38 MB and repartitioning by date cut it to 6; two jobs sharing a checkpoint corrupted the offset log. Live dashboard at yashhooda.ai/#metar; code at github.com/yashhooda1/metar-stream." },
  { id: "project-preflight-brief-2026", text: "Preflight Brief agent (Oct 2026): an extension of METAR Stream that turns a route (e.g. KAUS → KHOU) into a pilot-style preflight weather brief with go / caution / no-go flags. It pulls METARs, TAFs and NOTAMs, checks every observation and forecast group against selectable pilot minimums (conservative VFR, basic VFR, IFR with the 1-2-3 alternate rule), and fills missing TAFs with the nearest TAF station within 50 nm. Design choice: a deterministic rules engine owns the verdict and the LLM only writes the narrative, so a model can never talk a pilot into a NO-GO flight. The repo version is a multi-step tool-calling agent written against the raw Anthropic Messages API (no framework) with 18 unit tests; the site version is api/preflight-brief.js in the METAR section at yashhooda.ai/#metar. Not an official briefing; aviation remains a hobby for Yash." },
  { id: "project-climate-dashboards-2026", text: "Climate and energy dashboards on yashhooda.ai: ClimatePulse (56-year NOAA pipeline, 1970–2026, 13 global cities, Bronze/Silver/Gold with incremental per-station caching that cut each run from 741 API calls to 13, daily GitHub Actions refresh; Houston warming about +0.77°F per decade), Carbon & Warming (CO₂ and TCRE), Hurricane Analytics (HURDAT2, SST anomaly, ACE, rapid intensification, 'association not attribution' framing), Rising Seas (coastal risk and ice sheets), Data Centers (AI boom energy and water footprint), and ERCOT Grid (live Texas power demand)." },
  { id: "project-paceforge-2026", text: "PaceForge is Yash's offline AI running coach: it answers 'am I overtraining?' from his real Garmin and Strava history with training load, injury risk, race predictions and an adaptive 5K plan, with no API keys and no cloud inference. The LLM is the interface, not the reasoning engine: VDOT, Banister TRIMP, acute:chronic workload ratio and periodisation are deterministic, unit-tested functions. Two MCP servers (Garmin with 7 tools including structured-workout writes, Strava with 6 read tools), 289 tests, mypy --strict, CI on Linux/macOS/Windows including a smoke job that runs with no model and no network. github.com/yashhooda1/paceforge." },
  { id: "project-finetuning-2026", text: "Yash's fine-tuning work. Running Coach SFT: a 1,527-example instruction dataset on HuggingFace (hoodarunner/running-coach-sft) where every pace is generated from a VDOT implementation rather than typed; a LoRA fine-tune of Qwen2.5-3B learned the format almost perfectly but the arithmetic barely (off-zone paces 47.3% → 39.3%) — an honest negative result that backs PaceForge's design. Six years of his own Strava data (1,648 runs) replaced invented constants; an OLS regression with year fixed effects (n=462) found about 0.235 s/mi per °F of dew point. PySpark Coding Assistant: a QLoRA fine-tune trained on a free Colab T4 from 191 AST-validated synthetic examples. Offline ReAct Agent: a hand-written reasoning loop over a local Ollama model with six sandboxed tools and CI that runs without a model." },
  { id: "project-mcp-apple-2026", text: "Yash's MCP servers and Apple apps: mcp-garmin builds and schedules structured Garmin training plans from Claude; mcp-apple-workouts is the Apple Watch counterpart; qbo-excel-mcp syncs QuickBooks Online with Excel for finance automation. HoodaRun is a SwiftUI Apple Watch workout builder (Garmin Connect–style calendar) and HoodaRoutes generates running routes anywhere in the world. His Apple Silicon Lab section covers a local LLM benchmark lab, the RunOS Apple Health pipeline, a Siri + Shortcuts career agent, and SwiftUI iOS apps." },
  { id: "project-governance-fitcheck-2026", text: "Hooda AI Governance Studio (yashhooda.ai/solutions/ai-governance) turns responsible-AI principles into a decision tool: classify a use case across six risk signals and get one of four governance tiers with concrete human-oversight controls, exportable as a Markdown brief, aligned with NIST AI RMF, OECD and the EU AI Act. Fit Check (yashhooda.ai/#fit-check) lets a recruiter paste a job description: a keyword scan runs instantly in the browser and a Claude report scores the fit, cites the project proving each strength, lists honest gaps, and writes a tailored pitch." },
  { id: "site-features-2026", text: "yashhooda.ai also has: a ⌘K command palette that jumps to any section, an AI navigator, eight color themes (Terminal, Midnight, Aurora, Ember, Cockpit, Rose, Daylight, Paper), a live Strava training feed with route maps and photos, a live Infinite Flight tracker, live weather and radar, a sports dashboard (Astros, Texans, Rockets), a network analyzer, snow and hike photo albums, a build log, and running calculators: heat-adjusted pace with live METAR conditions, wind and cold adjustment, pace calculator, VDOT race predictor with training paces, and race time by temperature." },
  { id: "running-prs-2026", text: "Yash's running personal records: Mile 4:58; 5K 18:15 (2025 Women's Quarter Marathon, Houston Running Co, about 5:53/mi); 5-mile 30:22 and 8K 29:48 (2025 Sugar Land Turkey Trot); Half Marathon 1:24:31 (2025 Aramco Houston Half, about 6:27/mi); Marathon PR: none yet — marathon debut planned for late 2027 or early 2028. Last race: 2026 NYCRuns Brooklyn Experience Half Marathon in 1:27:41. Strava: strava.com/athletes/89409717." },
  { id: "running-goals-2026", text: "Yash's running goals as of October 2026: his lifelong goal is a sub-3:00 marathon, exactly as his About section says — now most likely attempted in 2028 after rebuilding base, speed and mileage. His current goal race is the 2027 Aramco Houston Half Marathon on January 17, 2027, where he wants to PR under 1:24:31. He had planned the 2027 Chevron Houston Marathon but postponed the marathon after moving to Austin and a lower-mileage summer. He trains at roughly 30–35 miles per week on a 12-week block from October 27, 2026 to January 17, 2027, built as structured workouts on his Apple Watch Ultra 4 (he switched from Garmin to an all-Apple setup synced to Strava in October 2026). Speed work is on roads and paths by GPS because there is no 400m track near him in Pflugerville." },
  { id: "race-calendar-2026-2027", text: "Yash's race calendar: October 31, 2026 — NYRR 5K in New York City (tune-up); November 8, 2026 — Run for the Water 5K in Austin (tune-up); December 13, 2026 — Coach Andy 30K, run as the long run / dress rehearsal for the half rather than an all-out race; January 17, 2027 — Aramco Houston Half Marathon, the goal race (PR attempt under 1:24:31). Earlier 2026 races he considered: Run Houston University of Houston 10K (Sep 19), Space City 10 Miler (Oct 11), Sugar Land Turkey Trot 8K (Nov 26), Sugar Land 30K (Dec 13). Longer term: a sub-3:00 marathon, likely in 2028." },
  { id: "running-coaching-2026", text: "Running advice Yash's assistant can give: to go sub-18 in the 5K from 18:15 — mile repeats near 5:40, weekly tempo at about 10K pace, strides twice a week, race often, taper about 10 days out. Half marathon: the long run is king (15–16 miles), a weekly threshold run, single-leg strength, a gel about every 45 minutes. Marathon: 80/20 easy/hard, 70–80 miles per week at peak for sub-3, goal-pace segments inside long runs, recovery is part of the plan. Heat: slow easy runs 60–90 seconds per mile in Houston or Austin summers, adjust by dew point (his own data shows about 0.235 s/mi per °F), use his heat-adjusted pace calculator. Injury prevention: no more than +10% mileage per week, hip/glute/calf strength, rotate shoes, 8–9 hours of sleep." },
  { id: "weather-climate-2026", text: "Weather and climate are a genuine interest for Yash and the domain where most of his pipeline work lives, because the data is messy, high-volume and public: METAR Stream for aviation weather, ClimatePulse for 56 years of NOAA records, plus hurricane, sea-level, CO₂, data-center and ERCOT grid dashboards. The site shows a visitor's local weather (Open-Meteo) and live radar. When he talks about weather work he connects it to engineering: dead-station handling, freshness checks, validation floors, incremental caching and CI that catches bad data before it lands." },
  { id: "career-engineering-path-2026", text: "Career advice Yash gives for Data and AI Engineering: you do not need a master's to break in — deployed projects, certifications and consistency win. Data path: SQL → Python → one cloud → Spark/Databricks; learn dbt, orchestration (Airflow/Dagster/GitHub Actions), data quality and streaming. AI path: learn the LLM APIs, build a real RAG system with evals, learn agents/MCP, try a small fine-tune and measure it honestly. Ship things that run unattended on real traffic, write post-mortems about what broke, and build in public. Yash is open to Data Engineering and AI Engineering roles — email yash.hooda6@gmail.com." },
  { id: "life-balance-2026", text: "Yash balances engineering work, running 30–40 miles a week, hobby flying, and time with family and friends. His strategies: protect run time like a meeting (morning or evening), treat the weekend long run as non-negotiable, meal prep on Sundays, keep easy days truly easy, sleep 8–9 hours, and stack habits (podcasts on runs, flight-planning as a weather lesson). He also enjoys astronomy, hiking (Lake Monarch near Granby, Colorado), travel, documentaries and Netflix." },
  { id: "certifications-2026", text: "Yash's certifications: Databricks Certified Data Engineer Associate; IBM AI Engineering Professional Certificate; IBM Data Science Professional Certificate; Vanderbilt AI Prompt Engineering; Microsoft Power Platform Fundamentals. His philosophy: real projects that are deployed and maintained beat certificates and coursework." },
  { id: "contact-2026", text: "Contact Yash Hooda: email yash.hooda6@gmail.com; LinkedIn linkedin.com/in/yash-hooda-384430242; GitHub github.com/yashhooda1; Upwork upwork.com/freelancers/~01d69d754fc4bf488e; YouTube youtube.com/@hoodarunner; Strava strava.com/athletes/89409717; HuggingFace hoodarunner; Ollama hoodarunner. Based in Austin, Texas; open to remote and hybrid roles." },
];

// Ingest current knowledge; add the legacy chunks only on request.
const chunks = process.env.INCLUDE_LEGACY ? [...currentChunks, ...legacyChunks] : currentChunks;

// Same hashed sparse vector as api/chat.js buildSparseVector(), so sparse queries match.
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 2);
}
function buildSparseVector(text) {
  const tokens = tokenize(text);
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const indices = [], values = [];
  for (const [term, count] of Object.entries(freq)) {
    let hash = 0;
    for (let i = 0; i < term.length; i++) hash = ((hash << 5) - hash + term.charCodeAt(i)) & 0x7fff;
    indices.push(hash % 30000); values.push(count / tokens.length);
  }
  return { indices, values };
}

// ── EMBED + UPSERT ──
async function embed(text) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI embedding error: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

async function main() {
  const requiredEnv = ["OPENAI_API_KEY", "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`❌ Missing env var: ${key}`);
      process.exit(1);
    }
  }

  const index = new Index({
    url: process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });

  // Clear stale (pre-aviation) chunks so removed ids don't linger in retrieval.
  if (!process.env.SKIP_RESET) {
    console.log("🧹 Resetting index to clear stale chunks...");
    await index.reset();
  }

  console.log(`🚀 Ingesting ${chunks.length} chunks into Upstash Vector...\n`);

  for (const chunk of chunks) {
    try {
      const vector = await embed(chunk.text);
      // dense + sparse; if the index was created dense-only, Upstash ignores/rejects sparse → retry dense-only
      try {
        await index.upsert({ id: chunk.id, vector, sparseVector: buildSparseVector(chunk.text), metadata: { text: chunk.text } });
      } catch (e) {
        await index.upsert({ id: chunk.id, vector, metadata: { text: chunk.text } });
      }
      console.log(`✅ ${chunk.id}`);
    } catch (err) {
      console.error(`❌ Failed: ${chunk.id} — ${err.message}`);
    }
  }

  console.log("\n✨ Done! Aviation-forward knowledge base embedded and stored in Upstash Vector.");
  console.log("   Your HoodaAgents chatbot now retrieves the current, aviation-first content.");
}

main();
