// lib/profile.js — ES Module
// ══════════════════════════════════════════════════════════════════════════════
// COMPACT CANDIDATE PROFILE for the lightweight AI endpoints (fit-check,
// navigate). Kept separate from api/chat.js's full CONTEXT so these functions
// stay small and cold-start fast. Keep the two in sync when the story changes.
// ══════════════════════════════════════════════════════════════════════════════

export const PROFILE = `
CANDIDATE: Yash Hooda — Data Engineer & AI Engineer. BS Computer Science, UT Dallas (May 2024).
Open to Data Engineering / AI Engineering roles (full-time or contract). Contact: yash.hooda6@gmail.com · yashhooda.ai · github.com/yashhooda1

CORE SKILLS
- Data engineering: PySpark, Databricks, Microsoft Fabric, SQL, Delta Lake, ETL/ELT, medallion (Bronze→Silver→Gold) architecture, Spark Structured Streaming, Kafka/Redpanda, watermarking & event-time dedupe, checkpointing/backpressure, data quality & reconciliation, incremental caching, scheduled pipelines on GitHub Actions.
- AI/ML engineering: Anthropic & OpenAI APIs, multi-model routing (Claude, GPT, Gemini, Grok, Llama), LangChain/LangGraph, hybrid RAG (dense + sparse/BM25, RRF fusion, CRAG grading, cross-encoder reranking), vector search (Upstash Vector, FAISS, Chroma), agentic/ReAct loops, MCP servers (Garmin, Strava, Apple Workouts, QuickBooks↔Excel), QLoRA/LoRA fine-tuning (PEFT, TRL, 4-bit NF4), offline eval harnesses with golden sets, local inference with Ollama, Azure OpenAI + Azure Document Intelligence document extraction.
- Platform & ops: Node.js, Python, FastAPI, Vercel serverless, Railway, Render, Docker, Redis/Upstash, Stripe, JWT auth, rate limiting, IP reputation, kill switches, content guards (7-layer security gateway), CI (pytest, Hypothesis property tests, mypy --strict, GitHub Actions across Linux/macOS/Windows).
- Analytics & viz: pandas, NumPy, scikit-learn, OLS with fixed effects, Chart.js, Leaflet, vanilla JS dashboards.
- Apple ecosystem: SwiftUI/watchOS apps (HoodaRun workout builder), Siri + Shortcuts agents, Apple Health pipelines, local LLM benchmark lab on Apple Silicon.

EXPERIENCE
- GSR Group (multi-unit restaurant franchise, 25 locations) — Data Engineer contract, Mar 2026–Jul 2026: owned the Toast POS ingestion pipeline.
- Ternio Group (healthcare supply chain) — built Microsoft Fabric ML models for document extraction on surgical-instrument records from vendors such as Stryker.
- Archrock (energy / natural-gas compression) — data engineering contract.
- CIMCO (manufacturing, aerospace-adjacent) — data engineering contract.
- Outlier AI — AI/ML data specialist.
- SLTX AI Data Extractor (2026) — AI policy-data extraction with Azure OpenAI + Document Intelligence (SMART XML).
- Independent (2025–present): built, deployed and operated the production systems below solo.

SHIPPED PROJECTS (all public, live, and maintained)
- HoodaAgents (yashhooda.ai): multi-model agentic AI platform — hybrid RAG over Upstash Vector, ReAct agent with Strava tools, voice I/O, image analysis, code agent, prompt lab, eval harness, Stripe-gated tiers, admin kill switch, 7-layer security gateway that held through a real attack campaign.
- METAR Stream: Kafka → Spark Structured Streaming → Delta medallion over ~1,100 airport stations; 240,997 raw messages / 10,018 retained after dedupe over 25.6 h with zero duplicate keys; survived a 181 s broker outage.
- ClimatePulse: 56-year NOAA pipeline across 13 cities, Bronze→Silver→Gold, daily GitHub Actions refresh, live dashboard; plus CO₂/TCRE, hurricane (HURDAT2), sea-level, data-center footprint and ERCOT grid dashboards.
- PaceForge: offline AI running coach — deterministic VDOT/TRIMP/ACWR engine, LLM only as the interface, two MCP servers, 289 tests, mypy --strict, CI proves it runs with no model/network.
- Running Coach SFT: 1,527-example instruction dataset on HuggingFace with generated (not typed) paces; LoRA fine-tune of Qwen2.5-3B with an honest negative result on arithmetic; OLS on 6 years of Strava data (n=462) for heat effects.
- PySpark Coding Assistant: synthetic-corpus QLoRA fine-tune (191 AST-validated examples) trained on a free Colab T4.
- Offline ReAct Agent: hand-written reasoning loop over a local Ollama model, six sandboxed tools, stdlib SSE server, CI without a model.
- mcp-garmin / mcp-apple-workouts / qbo-excel-mcp: MCP servers for structured workout writes and QuickBooks↔Excel finance automation.
- HoodaRun: SwiftUI Apple Watch workout builder; HoodaRoutes: worldwide running-route generator.
- Infinite Flight Live Tracker: FastAPI + Leaflet real-time flight tracker with cached upstream API.
- Hooda AI Governance Studio: risk-tiered human-oversight decision tool (NIST AI RMF / EU AI Act aligned).

CERTIFICATIONS
- Databricks Certified Data Engineer Associate; IBM AI Engineering; IBM Data Science; Vanderbilt AI Prompt Engineering; Microsoft Power Platform Fundamentals.

WORK STYLE
- Build-in-public; ships systems with rate limiters, kill switches, retries and monitoring; writes honest post-mortems ("the interesting part is what broke"); strong preference for deterministic logic with LLMs as the interface.
- Location: Austin, TX. Open to remote and hybrid; US work authorization questions should be asked directly.
`.trim();

// Keyword vocabulary used by the client-side quick scan and the server-side
// deterministic pre-score. Grouped so a JD hit on any alias counts once.
export const SKILL_GROUPS = [
  { name: 'Python',            aliases: ['python'] },
  { name: 'SQL',               aliases: ['sql', 't-sql', 'postgres', 'mysql', 'snowflake', 'bigquery', 'redshift'] },
  { name: 'PySpark / Spark',   aliases: ['pyspark', 'spark', 'structured streaming'] },
  { name: 'Databricks',        aliases: ['databricks', 'delta lake', 'delta live', 'unity catalog'] },
  { name: 'Microsoft Fabric',  aliases: ['fabric', 'synapse', 'power bi', 'azure data factory', 'adf'] },
  { name: 'Azure',             aliases: ['azure', 'azure openai', 'document intelligence'] },
  { name: 'AWS',               aliases: ['aws', 's3', 'glue', 'lambda', 'athena', 'emr', 'kinesis'] },
  { name: 'GCP',               aliases: ['gcp', 'google cloud', 'dataflow', 'pub/sub'] },
  { name: 'Kafka / Streaming', aliases: ['kafka', 'redpanda', 'streaming', 'real-time', 'realtime', 'event-driven'] },
  { name: 'ETL / ELT',         aliases: ['etl', 'elt', 'data pipeline', 'pipelines', 'ingestion', 'medallion', 'data warehouse', 'lakehouse'] },
  { name: 'Orchestration',     aliases: ['airflow', 'dagster', 'prefect', 'github actions', 'orchestration', 'scheduling'] },
  { name: 'dbt',               aliases: ['dbt'] },
  { name: 'Data Quality',      aliases: ['data quality', 'great expectations', 'reconciliation', 'validation', 'observability'] },
  { name: 'LLM APIs',          aliases: ['llm', 'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'large language'] },
  { name: 'RAG',               aliases: ['rag', 'retrieval', 'vector', 'embedding', 'embeddings', 'faiss', 'chroma', 'pinecone', 'weaviate', 'upstash'] },
  { name: 'Agents / MCP',      aliases: ['agent', 'agentic', 'mcp', 'tool use', 'function calling', 'react'] },
  { name: 'LangChain',         aliases: ['langchain', 'langgraph', 'llamaindex'] },
  { name: 'Fine-tuning',       aliases: ['fine-tun', 'finetun', 'lora', 'qlora', 'peft', 'sft', 'pytorch', 'hugging face', 'huggingface', 'transformers'] },
  { name: 'ML / Stats',        aliases: ['machine learning', 'scikit', 'sklearn', 'pandas', 'numpy', 'regression', 'statistics', 'statistical'] },
  { name: 'Evals',             aliases: ['eval', 'evaluation', 'benchmark', 'golden'] },
  { name: 'Node.js / JS',      aliases: ['node', 'javascript', 'typescript', 'react.js', 'next.js'] },
  { name: 'FastAPI / APIs',    aliases: ['fastapi', 'rest', 'api design', 'microservice'] },
  { name: 'Docker / K8s',      aliases: ['docker', 'kubernetes', 'k8s', 'container'] },
  { name: 'CI/CD',             aliases: ['ci/cd', 'cicd', 'continuous integration', 'testing', 'pytest', 'unit test'] },
  { name: 'Serverless',        aliases: ['serverless', 'vercel', 'cloud functions'] },
  { name: 'Redis',             aliases: ['redis', 'caching'] },
  { name: 'Security',          aliases: ['security', 'auth', 'rate limit', 'jwt', 'oauth'] },
  { name: 'Swift / iOS',       aliases: ['swift', 'swiftui', 'ios', 'watchos', 'xcode'] },
  { name: 'Terraform / IaC',   aliases: ['terraform', 'infrastructure as code', 'iac', 'cloudformation'] },
  { name: 'Scala / Java',      aliases: ['scala', 'java '] },
  { name: 'Go',                aliases: [' go ', 'golang'] },
  { name: 'Tableau / BI',      aliases: ['tableau', 'looker', 'business intelligence', 'dashboards'] },
];

// Skills Yash does NOT have deep evidence for — the server marks these as gaps
// rather than letting the model bluff. (Used for honesty in fit-check.)
export const KNOWN_GAPS = new Set(['AWS', 'GCP', 'dbt', 'Terraform / IaC', 'Scala / Java', 'Go', 'Tableau / BI', 'Docker / K8s']);
export const PARTIAL = new Set(['Docker / K8s', 'Tableau / BI']); // some evidence (Docker yes, K8s no; Chart.js dashboards yes, Tableau no)

export function scanKeywords(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = [], misses = [];
  for (const g of SKILL_GROUPS) {
    const present = g.aliases.some(a => t.includes(a.toLowerCase()));
    if (!present) continue;
    if (KNOWN_GAPS.has(g.name) && !PARTIAL.has(g.name)) misses.push(g.name);
    else hits.push({ name: g.name, partial: PARTIAL.has(g.name) });
  }
  return { hits, misses };
}
