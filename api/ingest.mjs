/**
 * scripts/ingest.mjs
 * Run ONCE locally to (re)seed your Upstash Vector index with Yash's portfolio content.
 * Aviation-forward: leads with the pilot journey, engineering as the foundation.
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
const chunks = [
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
      await index.upsert({ id: chunk.id, vector, metadata: { text: chunk.text } });
      console.log(`✅ ${chunk.id}`);
    } catch (err) {
      console.error(`❌ Failed: ${chunk.id} — ${err.message}`);
    }
  }

  console.log("\n✨ Done! Aviation-forward knowledge base embedded and stored in Upstash Vector.");
  console.log("   Your HoodaAgents chatbot now retrieves the current, aviation-first content.");
}

main();
