/**
 * scripts/ingest.mjs
 * Run ONCE locally to seed your Upstash Vector index with Yash's portfolio content.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... \
 *   UPSTASH_VECTOR_REST_URL=https://... \
 *   UPSTASH_VECTOR_REST_TOKEN=... \
 *   node scripts/ingest.mjs
 *
 * Re-run any time you update chunks below (it upserts, so safe to re-run).
 */

import { Index } from "@upstash/vector";

// ── KNOWLEDGE CHUNKS ──
// Each chunk is an independent piece of knowledge the chatbot can retrieve.
// Add, edit, or remove chunks here freely — just re-run the script after.
const chunks = [
  {
    id: "bio",
    text: "Yash Hooda is a 24-year-old Data Engineer based in Texas with a BS in Computer Science from University of Texas at Dallas (UTD). He is passionate about intelligent systems, running, aviation, astronomy, hiking, and travel. His goal is to transition into AI Engineering without a master's degree.",
  },
  {
    id: "skills",
    text: "Yash's technical skills include: Data Engineering (PySpark, Databricks, Microsoft Fabric, SQL, Delta Lake, ETL/ELT), AI/ML (OpenAI API, LangChain, Streamlit, scikit-learn, TensorFlow, NLP, LLMs, deep learning, prompt engineering), Python as primary language, platforms including Azure, GitHub, Vercel, and Streamlit Cloud.",
  },
  {
    id: "certifications",
    text: "Yash holds 5 certifications: Databricks Certified Data Engineer Associate, IBM AI Engineering Professional Certificate, IBM Data Science Professional Certificate, Vanderbilt University AI Prompt Engineering Professional Certificate, and Microsoft Certified Power Platform Fundamentals.",
  },
  {
    id: "project-hiring-engine",
    text: "HoodaAgents AI Hiring Engine: AI-powered resume analysis system built with Python, Streamlit, OpenAI API, and pdfplumber. Parses PDF resumes, extracts candidate intelligence, matches skills to job descriptions, and generates fit reports with strengths and gaps. Live on Streamlit Cloud.",
  },
  {
    id: "project-climatepulse",
    text: "ClimatePulse: 55-year (1970–2025) NOAA climate analytics pipeline for Houston (IAH) and Newark (EWR). Uses Bronze→Silver→Gold medallion architecture. Key findings: Houston warming +0.805°F/decade, winter nighttime warming +1.005°F/decade, Feb-Mar 80°F days +1.721/decade, Newark +0.472°F/decade. Built with Python, pandas, scikit-learn, matplotlib.",
  },
  {
    id: "project-hoodaagents",
    text: "HoodaAgents GPT-4 AI Assistant: Custom LangChain agent with conversational memory, live web search via Tavily API, and a calculator tool. Demonstrates end-to-end agentic design and local deployment. Built with GPT-4, LangChain, and Streamlit.",
  },
  {
    id: "project-others",
    text: "Other projects by Yash: Virtual TA Chatbot (senior capstone, NLP-powered for student course queries), Liver Cancer Prediction (ML model with feature engineering), Food Demand Forecasting (ML for restaurant optimization), TogetherAI Agent (LLaMA 3.3 70B via Together.ai), IBM AI Engineering Capstone (image recognition + predictive analytics), TARS (custom GPT-4 assistant on ChatGPT platform).",
  },
  {
    id: "running-prs",
    text: "Yash's running personal records: 5K — 18:15 at 2025 Women's Quarter Marathon Houston (5:53/mi pace), 5-Mile — 30:22 at 2025 Sugar Land Turkey Trot (6:04/mi), 8K — 29:48 at 2025 Sugar Land Turkey Trot (5:59/mi), Half Marathon — 1:24:31 at 2025 Aramco Houston Half Marathon (6:27/mi). Last race: 2026 NYCRuns Brooklyn Experience HM in 1:27:41. Marathon PR: TBD, currently in training.",
  },
  {
    id: "running-training",
    text: "Yash currently runs 45 miles per week and is in Week 3 of Boulderthon Marathon training. Target race is the 2026 Boulderthon Marathon in Boulder, CO. He trains 5-6 days per week using the 80/20 rule: 80% easy runs, 20% hard workouts including tempo runs, intervals, and long runs.",
  },
  {
    id: "contact",
    text: "Contact Yash: Email yash.hooda6@gmail.com, LinkedIn linkedin.com/in/yash-hooda-384430242, GitHub github.com/yashhooda1, Upwork upwork.com/freelancers/~01d69d754fc4bf488e, YouTube youtube.com/@hoodarunner, Linktree linktr.ee/hooda_yash1, Strava strava.com/athletes/89409717. Available for freelance work on Upwork.",
  },
  {
    id: "career-ai-path",
    text: "AI Engineering path without a master's degree: Python fundamentals → ML basics (scikit-learn) → deep learning (PyTorch/TensorFlow) → LLMs and prompt engineering → building AI agents → MLOps and deployment. Key skills: LangChain, vector databases (Pinecone, Weaviate, ChromaDB), RAG, OpenAI/Anthropic APIs, Hugging Face, FastAPI. Build real projects, deploy publicly, write on LinkedIn.",
  },
  {
    id: "career-data-path",
    text: "Data Engineering path: SQL mastery → Python → cloud platform (AWS/Azure/GCP) → distributed compute (Spark/Databricks). Key certifications: Databricks Data Engineer, dbt Analytics Engineer, AWS Data Engineer Associate. Tools: dbt, Airflow, Kafka, Spark, Delta Lake, Snowflake, BigQuery. Entry-level: SQL + Python + one cloud. Mid-level: add orchestration + streaming.",
  },
  {
    id: "life-balance",
    text: "Yash balances a demanding 8-5 Data Engineering job, 45 miles/week of running, and building AI side projects. Strategies: morning runs before work (5-6am), weekend long runs treated as non-negotiable, Sunday meal prep, time-blocking workouts in calendar, 30-60 min of focused daily building over weekend marathons, 8-9 hours sleep as #1 performance lever.",
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

  console.log("\n✨ Done! All chunks embedded and stored in Upstash Vector.");
  console.log("   Your HoodaAgents chatbot now has RAG capability.");
}

main();
