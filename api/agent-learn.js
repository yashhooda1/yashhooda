// api/agent-learn.js
// Background learning loop — runs on Vercel Cron daily at 6am UTC
// Hits 4 sources: Strava, GitHub, Web Search, Chat Analytics
// Embeds new knowledge into Upstash Vector + logs to Redis

import { Index } from '@upstash/vector';
import { Redis } from '@upstash/redis';
import { notifyFailure } from './_notify.js';

export const maxDuration = 90;

const AGENT_LOG_KEY   = 'hooda_agent:activity_log';
const AGENT_LOG_LIMIT = 50; // keep last 50 log entries

// ── EMBED TEXT INTO UPSTASH VECTOR ──────────────────────────────────────────
async function embedAndStore(vectorIndex, chunks, source) {
  if (!chunks.length) return 0;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return 0;

  let stored = 0;
  for (const chunk of chunks) {
    try {
      const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: chunk.text.slice(0, 8000) }),
      });
      const embedData = await embedRes.json();
      const vector    = embedData?.data?.[0]?.embedding;
      if (!vector) continue;

      await vectorIndex.upsert({
        id:       `agent_learn_${source}_${Date.now()}_${stored}`,
        vector,
        metadata: {
          text:      chunk.text,
          source:    chunk.source || source,
          learnedAt: new Date().toISOString(),
          type:      'agent_learned',
        },
      });
      stored++;
    } catch (e) {
      console.warn(`[AGENT-LEARN] Embed failed for chunk: ${e.message}`);
    }
  }
  return stored;
}

// ── SOURCE 1: STRAVA ────────────────────────────────────────────────────────
async function learnFromStrava() {
  const log = { source: 'Strava', findings: [], vectorsAdded: 0 };
  try {
    // Refresh token
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
    const tokenData   = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) { log.findings.push('⚠️ Could not refresh Strava token'); return log; }

    const activitiesRes = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=10&page=1',
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const activities = await activitiesRes.json();
    if (!Array.isArray(activities)) { log.findings.push('⚠️ No activities returned'); return log; }

    const runs   = activities.filter(a => a.type === 'Run' || a.sport_type === 'Run');
    const totalMi = runs.reduce((s, r) => s + (r.distance / 1609.34), 0);

    log.findings.push(`📍 Fetched ${runs.length} recent runs (${totalMi.toFixed(1)} mi total)`);

    // Detect PRs — look for fastest pace
    const paces = runs.map(r => ({
      name: r.name,
      date: r.start_date?.slice(0, 10),
      dist: (r.distance / 1609.34).toFixed(2),
      pace: r.moving_time && r.distance ? (r.moving_time / 60 / (r.distance / 1609.34)).toFixed(2) : null,
      hr:   r.average_heartrate,
    }));

    const fastest = paces.reduce((a, b) => (parseFloat(a.pace) < parseFloat(b.pace) ? a : b), paces[0]);
    if (fastest?.pace) log.findings.push(`⚡ Fastest recent run: ${fastest.dist}mi @ ${fastest.pace}min/mi`);

    // Build knowledge chunk
    const summary = `STRAVA UPDATE (${new Date().toISOString().slice(0, 10)}):
Recent ${runs.length} runs totaling ${totalMi.toFixed(1)} miles.
${paces.map(p => `- ${p.date}: ${p.dist}mi @ ${p.pace || 'N/A'}min/mi${p.hr ? `, HR ${Math.round(p.hr)}bpm` : ''}`).join('\n')}
Fastest recent run: ${fastest?.dist}mi @ ${fastest?.pace}min/mi on ${fastest?.date}.`;

    return { ...log, chunks: [{ text: summary, source: 'strava_activities' }] };
  } catch (err) {
    log.findings.push(`❌ Strava error: ${err.message}`);
    return log;
  }
}

// ── SOURCE 2: GITHUB ────────────────────────────────────────────────────────
async function learnFromGitHub() {
  const log = { source: 'GitHub', findings: [], vectorsAdded: 0 };
  try {
    const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'yashhooda-agent' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

    // Get recent commits across all repos
    const eventsRes  = await fetch('https://api.github.com/users/yashhooda1/events/public?per_page=30', { headers });
    const events     = await eventsRes.json();

    if (!Array.isArray(events)) { log.findings.push('⚠️ No GitHub events returned'); return log; }

    const pushEvents = events.filter(e => e.type === 'PushEvent').slice(0, 10);
    const commits    = pushEvents.flatMap(e =>
      (e.payload?.commits || []).map(c => ({
        repo:    e.repo?.name?.replace('yashhooda1/', ''),
        message: c.message?.slice(0, 120),
        date:    e.created_at?.slice(0, 10),
      }))
    );

    log.findings.push(`🐙 ${commits.length} recent commits across ${new Set(commits.map(c => c.repo)).size} repos`);

    // Get repo list
    const reposRes = await fetch('https://api.github.com/users/yashhooda1/repos?sort=updated&per_page=10', { headers });
    const repos    = await reposRes.json();
    const repoList = Array.isArray(repos)
      ? repos.map(r => `${r.name} (${r.language || 'misc'}, ⭐${r.stargazers_count})`).join(', ')
      : '';

    if (repoList) log.findings.push(`📂 Active repos: ${repoList.slice(0, 200)}`);

    const summary = `GITHUB UPDATE (${new Date().toISOString().slice(0, 10)}):
Recent commits by Yash Hooda (yashhooda1):
${commits.map(c => `- [${c.repo}] ${c.date}: ${c.message}`).join('\n')}
Active repositories: ${repoList}`;

    return { ...log, chunks: [{ text: summary, source: 'github_activity' }] };
  } catch (err) {
    log.findings.push(`❌ GitHub error: ${err.message}`);
    return log;
  }
}

// ── SOURCE 3: WEB SEARCH ────────────────────────────────────────────────────
async function learnFromWeb() {
  const log = { source: 'Web', findings: [], vectorsAdded: 0 };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log.findings.push('⚠️ No Anthropic key'); return log; }

  const queries = [
    'AI engineering career trends 2026',
    'data engineering tools trends 2026',
    'marathon training science latest research',
  ];

  const chunks = [];
  for (const query of queries) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{
            role: 'user',
            content: `Search for: "${query}". Summarize the top 3 findings in 2-3 sentences total. Be factual and concise.`,
          }],
        }),
      });
      const data    = await res.json();
      const text    = (data?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (text) {
        chunks.push({ text: `WEB SEARCH (${new Date().toISOString().slice(0, 10)}) — ${query}:\n${text}`, source: 'web_search' });
        log.findings.push(`🌐 Searched: "${query}"`);
      }
    } catch (e) {
      log.findings.push(`⚠️ Web search failed: ${query}`);
    }
  }

  return { ...log, chunks };
}

// ── SOURCE 4: CHAT ANALYTICS ─────────────────────────────────────────────────
async function learnFromChatPatterns(redis) {
  const log = { source: 'Chat', findings: [], vectorsAdded: 0 };
  try {
    const questions = await redis.lrange('hooda_analytics:questions', 0, 99);
    if (!questions?.length) { log.findings.push('💬 No chat questions yet'); return log; }

    const parsed = questions.map(q => {
      try { return typeof q === 'string' ? JSON.parse(q) : q; } catch { return null; }
    }).filter(Boolean);

    const agentCounts = {};
    parsed.forEach(q => { agentCounts[q.agent || 'general'] = (agentCounts[q.agent || 'general'] || 0) + 1; });

    const topAgent  = Object.entries(agentCounts).sort((a, b) => b[1] - a[1])[0];
    const recentQs  = parsed.slice(0, 10).map(q => q.q).filter(Boolean);

    log.findings.push(`💬 ${parsed.length} questions analyzed`);
    if (topAgent) log.findings.push(`📊 Most active agent: ${topAgent[0]} (${topAgent[1]} questions)`);

    // Use Claude to detect knowledge gaps
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && recentQs.length > 0) {
      const gapRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `These are recent questions users asked a chatbot about Yash Hooda (Data/AI Engineer, runner):\n${recentQs.join('\n')}\n\nIdentify 2-3 topic gaps where the bot might lack knowledge. Be specific. Reply in 2-3 sentences.`,
          }],
        }),
      });
      const gapData = await gapRes.json();
      const gaps    = gapData?.content?.[0]?.text?.trim();
      if (gaps) {
        log.findings.push(`🔍 Gap detected: ${gaps.slice(0, 100)}`);
        return {
          ...log,
          chunks: [{
            text: `CHAT PATTERN ANALYSIS (${new Date().toISOString().slice(0, 10)}):\nTop questions: ${recentQs.slice(0, 5).join(' | ')}\nAgent breakdown: ${JSON.stringify(agentCounts)}\nKnowledge gaps identified: ${gaps}`,
            source: 'chat_analytics',
          }],
        };
      }
    }
    return log;
  } catch (err) {
    log.findings.push(`❌ Chat analytics error: ${err.message}`);
    return log;
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow Vercel Cron (GET) or manual trigger (POST)
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Security: verify cron secret or admin key
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET || 'hooda-cron-2026';
  if (authHeader !== `Bearer ${cronSecret}` && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  console.log('[AGENT-LEARN] Background learning cycle starting...');

  let vectorIndex = null;
  let redis       = null;

  try {
    // Init clients
    if (process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN) {
      vectorIndex = new Index({
        url:   process.env.UPSTASH_VECTOR_REST_URL,
        token: process.env.UPSTASH_VECTOR_REST_TOKEN,
      });
    }
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      redis = new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    }

    // ── Run all 4 sources in parallel ──
    const [stravaResult, githubResult, webResult, chatResult] = await Promise.all([
      learnFromStrava(),
      learnFromGitHub(),
      learnFromWeb(),
      redis ? learnFromChatPatterns(redis) : Promise.resolve({ source: 'Chat', findings: ['⚠️ No Redis'], chunks: [] }),
    ]);

    const allResults = [stravaResult, githubResult, webResult, chatResult];

    // ── Embed all new knowledge into Upstash Vector ──
    let totalVectors = 0;
    if (vectorIndex) {
      for (const result of allResults) {
        if (result.chunks?.length) {
          const count = await embedAndStore(vectorIndex, result.chunks, result.source);
          result.vectorsAdded = count;
          totalVectors += count;
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Build activity log entry ──
    const logEntry = {
      type:      'BACKGROUND_LEARNING',
      timestamp: new Date().toISOString(),
      elapsed:   `${elapsed}s`,
      vectors:   totalVectors,
      sources:   allResults.map(r => ({
        source:      r.source,
        findings:    r.findings,
        vectors:     r.vectorsAdded || 0,
      })),
    };

    // ── Save to Redis activity log ──
    if (redis) {
      await redis.lpush(AGENT_LOG_KEY, JSON.stringify(logEntry));
      await redis.ltrim(AGENT_LOG_KEY, 0, AGENT_LOG_LIMIT - 1);
    }

    console.log(`[AGENT-LEARN] Complete in ${elapsed}s — ${totalVectors} vectors added`);

    // ── Push notification ──
    const ntfyTopic = process.env.NTFY_TOPIC || 'yash-agent-alerts';
    const summary   = allResults.flatMap(r => r.findings).slice(0, 5).join(' | ');
    try {
      await fetch(`https://ntfy.sh/${ntfyTopic}`, {
        method: 'POST',
        headers: { 'Title': 'Agent learned new knowledge', 'Tags': 'brain,robot', 'Priority': 'low' },
        body: `${summary.replace(/[^\x00-\xFF]/g, '?')} | ${totalVectors} vectors added in ${elapsed}s`,
      });
    } catch {}

    return res.status(200).json({ ok: true, elapsed, vectors: totalVectors, sources: logEntry.sources });

  } catch (err) {
    console.error('[AGENT-LEARN] Fatal error:', err);
    await notifyFailure({ route: '/api/agent-learn', model: 'background', error: err });
    return res.status(500).json({ error: err.message });
  }
}
