// api/agent-research.js
// On-demand autonomous research agent — fires when RAG confidence is low
// ReAct loop: Reason → Act (tool call) → Observe → repeat up to 3 times
// Stores findings back into Upstash Vector permanently

import { Index } from '@upstash/vector';
import { Redis } from '@upstash/redis';
import { notifyFailure } from './_notify.js';

export const maxDuration = 90;

const AGENT_LOG_KEY = 'hooda_agent:activity_log';

// ── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = {
  web_search: {
    description: 'Search the web for current information',
    async run(query) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: `Search: "${query}". Return 3-4 sentences of factual findings only.` }],
        }),
      });
      const data = await res.json();
      return (data?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim() || 'No results found.';
    },
  },

  fetch_strava: {
    description: 'Fetch latest Strava activities and stats for Yash',
    async run() {
      try {
        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id:     process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            grant_type:    'refresh_token',
            refresh_token: process.env.STRAVA_REFRESH_TOKEN,
          }),
        });
        const { access_token } = await tokenRes.json();
        if (!access_token) return 'Could not authenticate with Strava.';

        const activitiesRes = await fetch(
          'https://www.strava.com/api/v3/athlete/activities?per_page=5',
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const activities = await activitiesRes.json();
        if (!Array.isArray(activities)) return 'No Strava activities found.';

        return activities
          .filter(a => a.type === 'Run' || a.sport_type === 'Run')
          .map(a => `${a.start_date?.slice(0, 10)}: ${(a.distance / 1609.34).toFixed(2)}mi in ${Math.floor(a.moving_time / 60)}min`)
          .join('\n') || 'No recent runs found.';
      } catch (e) {
        return `Strava fetch error: ${e.message}`;
      }
    },
  },

  fetch_github: {
    description: 'Fetch latest GitHub activity for Yash Hooda',
    async run() {
      try {
        const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'yashhooda-agent' };
        if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

        const res    = await fetch('https://api.github.com/users/yashhooda1/events/public?per_page=10', { headers });
        const events = await res.json();
        if (!Array.isArray(events)) return 'No GitHub events found.';

        return events
          .filter(e => e.type === 'PushEvent')
          .slice(0, 5)
          .flatMap(e => (e.payload?.commits || []).map(c => `[${e.repo?.name?.replace('yashhooda1/', '')}] ${c.message?.slice(0, 80)}`))
          .join('\n') || 'No recent commits found.';
      } catch (e) {
        return `GitHub fetch error: ${e.message}`;
      }
    },
  },
};

// ── REACT AGENT LOOP ─────────────────────────────────────────────────────────
async function reactLoop(query, maxSteps = 3) {
  const apiKey  = process.env.ANTHROPIC_API_KEY;
  const toolLog = [];
  let   context = '';

  const systemPrompt = `You are an autonomous research agent for Yash Hooda's portfolio chatbot.
You have 3 tools: web_search, fetch_strava, fetch_github.
For each step, respond with ONLY valid JSON in this format:
{"thought": "what I'm thinking", "action": "tool_name", "input": "tool input or empty string"}
OR when done:
{"thought": "my final reasoning", "action": "DONE", "answer": "complete answer to the query"}
Be concise. Max ${maxSteps} tool calls.`;

  const messages = [
    { role: 'user', content: `Research query: "${query}"\n\nAvailable tools:\n- web_search: search the web\n- fetch_strava: get Yash's latest runs\n- fetch_github: get Yash's latest code activity\n\nStart your research.` }
  ];

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 512,
        system:     systemPrompt,
        messages,
      }),
    });

    const data     = await res.json();
    const rawText  = data?.content?.[0]?.text?.trim() ?? '';

    // Parse JSON response
    let parsed;
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch {
      break;
    }

    if (!parsed) break;

    // Push agent's reasoning to message history
    messages.push({ role: 'assistant', content: rawText });

    if (parsed.action === 'DONE') {
      return { answer: parsed.answer || context, toolLog, steps: step + 1 };
    }

    // Execute tool
    const tool = TOOLS[parsed.action];
    if (!tool) {
      messages.push({ role: 'user', content: `Tool "${parsed.action}" not found. Use: web_search, fetch_strava, fetch_github.` });
      continue;
    }

    console.log(`[AGENT-RESEARCH] Step ${step + 1}: ${parsed.action}("${(parsed.input || '').slice(0, 60)}")`);
    const observation = await tool.run(parsed.input || query);
    toolLog.push({ tool: parsed.action, input: parsed.input, output: observation.slice(0, 200) });
    context += `\n\nTool: ${parsed.action}\nResult: ${observation}`;

    messages.push({ role: 'user', content: `Tool result:\n${observation}\n\nContinue research or respond with DONE if you have enough information.` });
  }

  // Fallback: synthesize from context
  if (context) {
    const synthRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Based on this research:\n${context}\n\nAnswer this query concisely: "${query}"`,
        }],
      }),
    });
    const synthData = await synthRes.json();
    return {
      answer:  synthData?.content?.[0]?.text?.trim() ?? 'Could not synthesize answer.',
      toolLog,
      steps:   maxSteps,
    };
  }

  return { answer: 'Research inconclusive — please try rephrasing your question.', toolLog, steps: 0 };
}

// ── EMBED AND STORE FINDING ──────────────────────────────────────────────────
async function storeFinding(vectorIndex, query, answer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !vectorIndex) return;
  try {
    const text     = `Q: ${query}\nA: ${answer}`;
    const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    });
    const embedData = await embedRes.json();
    const vector    = embedData?.data?.[0]?.embedding;
    if (!vector) return;
    await vectorIndex.upsert({
      id:       `research_${Date.now()}`,
      vector,
      metadata: { text, source: 'agent_research', learnedAt: new Date().toISOString(), type: 'agent_learned' },
    });
  } catch (e) {
    console.warn('[AGENT-RESEARCH] Store finding failed:', e.message);
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, sessionId } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const startTime = Date.now();
  console.log(`[AGENT-RESEARCH] On-demand research: "${query.slice(0, 80)}"`);

  try {
    let vectorIndex = null;
    let redis       = null;

    if (process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN) {
      vectorIndex = new Index({ url: process.env.UPSTASH_VECTOR_REST_URL, token: process.env.UPSTASH_VECTOR_REST_TOKEN });
    }
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    }

    // Run ReAct loop
    const { answer, toolLog, steps } = await reactLoop(query);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Store finding permanently in vector DB
    await storeFinding(vectorIndex, query, answer);

    // Log to Redis activity log
    const logEntry = {
      type:      'ON_DEMAND_RESEARCH',
      timestamp: new Date().toISOString(),
      query:     query.slice(0, 150),
      steps,
      elapsed:   `${elapsed}s`,
      tools:     toolLog.map(t => t.tool),
      vectorStored: true,
    };
    if (redis) {
      await redis.lpush(AGENT_LOG_KEY, JSON.stringify(logEntry));
      await redis.ltrim(AGENT_LOG_KEY, 0, 49);
    }

    console.log(`[AGENT-RESEARCH] Complete in ${elapsed}s — ${steps} steps, ${toolLog.length} tool calls`);

    return res.status(200).json({ answer, toolLog, steps, elapsed });

  } catch (err) {
    console.error('[AGENT-RESEARCH] Error:', err);
    await notifyFailure({ route: '/api/agent-research', model: 'react', error: err, userMessage: query, sessionId });
    return res.status(500).json({ error: err.message });
  }
}
