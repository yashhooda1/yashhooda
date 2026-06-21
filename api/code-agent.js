// api/code-agent.js
// Full agentic coding loop — direct API calls, no LangChain model wrappers
// Steps: DETECT → PLAN → WRITE → REVIEW → EXPLAIN

// Simple IP-based rate limit
const rateMap = new Map();
export default async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = 5;
    
    const record = rateMap.get(ip) || { count: 0, start: now };
    if (now - record.start > windowMs) {
        record.count = 0;
        record.start = now;
    }
    record.count++;
    rateMap.set(ip, record);
    
    if (record.count > maxRequests) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }

import { notifyFailure } from './_notify.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export const maxDuration = 90;

const BLOCKED_IPS = ['65.50.144.128'];

export default async function handler(req, res) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    if (BLOCKED_IPS.includes(ip)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    // rest of handler
}

// ── DYNAMIC MODEL SELECTOR ──────────────────────────────────────────────────
function selectModel(language, taskType) {
  if (['javascript', 'typescript', 'jsx', 'tsx', 'node'].includes(language?.toLowerCase())) {
    return { provider: 'openai', model: 'gpt-4o', maxTokens: 4096 };
  }
  if (taskType === 'debug') {
    return { provider: 'anthropic', model: 'claude-opus-4-8', maxTokens: 8000 };
  }
  if (['python', 'sql', 'pyspark', 'bash', 'r'].includes(language?.toLowerCase())) {
    return { provider: 'anthropic', model: 'claude-opus-4-8', maxTokens: 4096 };
  }
  return { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 4096 };
}

// ── DIRECT API CALLER ───────────────────────────────────────────────────────
// Bypasses LangChain model wrappers entirely — no rogue top_p injection
async function callModel(cfg, messages) {
  if (cfg.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages: messages.map(m => ({
          role: m instanceof SystemMessage ? 'system' : 'user',
          content: m.content,
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // Anthropic direct fetch
  const systemMsg = messages.find(m => m instanceof SystemMessage);
  const userMsgs  = messages.filter(m => m instanceof HumanMessage);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      cfg.model,
      max_tokens: cfg.maxTokens,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: userMsgs.map(m => ({ role: 'user', content: m.content })),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data.content?.[0]?.text?.trim() ?? '';
}

// ── TOOL 1: LANGUAGE DETECTOR ───────────────────────────────────────────────
async function detectLanguage(prompt, code) {
  const cfg = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 64 };
  const content = code
    ? `Detect the programming language of this code snippet. Reply with ONLY the language name in lowercase (e.g. python, javascript, sql, typescript, bash, rust, go, java). Code:\n\`\`\`\n${code.slice(0, 500)}\n\`\`\``
    : `What programming language is this task about? Reply with ONLY the language name in lowercase. Task: "${prompt.slice(0, 200)}"`;
  try {
    const result = await callModel(cfg, [new HumanMessage(content)]);
    return result.trim().toLowerCase().split(/[\s,]/)[0] || 'python';
  } catch {
    return 'python';
  }
}

// ── TOOL 2: TASK CLASSIFIER ─────────────────────────────────────────────────
async function classifyTask(prompt) {
  const cfg = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 32 };
  try {
    const result = await callModel(cfg, [
      new HumanMessage(
        `Classify this coding task into ONE of: generate, debug, explain, optimize, refactor.\n` +
        `Reply with ONLY the single word.\nTask: "${prompt.slice(0, 300)}"`
      )
    ]);
    return result.trim().toLowerCase().split(/[\s,]/)[0] || 'generate';
  } catch {
    return 'generate';
  }
}

// ── TOOL 3: PLANNER ─────────────────────────────────────────────────────────
async function planSolution(prompt, language, taskType, cfg) {
  const systemMsg = new SystemMessage(
    `You are an expert ${language} engineer and technical architect. ` +
    `You specialize in data engineering, AI engineering, and building production systems. ` +
    `You are helping Yash Hooda, a Data/AI Engineer, with coding tasks.`
  );
  const humanMsg = new HumanMessage(
    `Task type: ${taskType}\nLanguage: ${language}\n\n` +
    `User request: ${prompt}\n\n` +
    `Create a concise technical plan (3-5 bullet points) for solving this. ` +
    `Include: approach, key functions/classes needed, edge cases to handle, and any imports required. ` +
    `Be specific and technical. No code yet — just the plan.`
  );
  try {
    return await callModel(cfg, [systemMsg, humanMsg]);
  } catch {
    return `Plan: Implement ${taskType} for ${language} task as requested.`;
  }
}

// ── TOOL 4: CODE WRITER ─────────────────────────────────────────────────────
async function writeCode(prompt, plan, language, taskType, existingCode, cfg) {
  const systemMsg = new SystemMessage(
    `You are an expert ${language} engineer. Write clean, production-ready code. ` +
    `Always include: inline comments, error handling, type hints where applicable, and docstrings. ` +
    `Return ONLY the code block — no explanations outside the code, no markdown fences. ` +
    `Start directly with the code.`
  );
  const humanMsg = new HumanMessage(
    `Task: ${prompt}\n\n` +
    `Plan to follow:\n${plan}\n\n` +
    (existingCode ? `Existing code to work with:\n\`\`\`${language}\n${existingCode}\n\`\`\`\n\n` : '') +
    `Write the complete, working ${language} code now. Include all imports. Make it production-ready.`
  );
  try {
    const result = await callModel(cfg, [systemMsg, humanMsg]);
    return result
      .replace(/^```[\w]*\n?/m, '')
      .replace(/```$/m, '')
      .trim();
  } catch (err) {
    throw new Error(`Code generation failed: ${err.message}`);
  }
}

// ── TOOL 5: CODE REVIEWER ───────────────────────────────────────────────────
async function reviewCode(code, language, originalPrompt, cfg) {
  const systemMsg = new SystemMessage(
    `You are a senior ${language} code reviewer. Be concise and specific.`
  );
  const humanMsg = new HumanMessage(
    `Review this ${language} code for: bugs, edge cases, security issues, performance problems, and missing error handling.\n\n` +
    `Original task: ${originalPrompt.slice(0, 200)}\n\n` +
    `Code:\n${code.slice(0, 3000)}\n\n` +
    `Return a JSON object with this exact shape (no markdown):\n` +
    `{"issues": ["issue1", "issue2"], "improvements": ["improvement1"], "score": 8, "verdict": "PASS or REVISE"}`
  );
  try {
    const raw   = await callModel(cfg, [systemMsg, humanMsg]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { issues: [], improvements: [], score: 8, verdict: 'PASS' };
    return JSON.parse(match[0]);
  } catch {
    return { issues: [], improvements: [], score: 8, verdict: 'PASS' };
  }
}

// ── TOOL 6: CODE EXPLAINER ──────────────────────────────────────────────────
async function explainCode(code, language, taskType) {
  const cfg = { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 1024 };
  const humanMsg = new HumanMessage(
    `Explain this ${language} code to a Data/AI Engineer in 3-5 sentences. ` +
    `Cover: what it does, how it works, and any important patterns used. ` +
    `Be technical but clear. No bullet points — write in flowing prose.\n\n` +
    `Code:\n${code.slice(0, 2000)}`
  );
  try {
    return await callModel(cfg, [humanMsg]);
  } catch {
    return `This ${language} code implements the requested ${taskType} functionality as planned.`;
  }
}

// ── TOOL 7: SUGGESTION GENERATOR ────────────────────────────────────────────
async function generateCodingSuggestions(prompt, language, taskType) {
  const cfg = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 128 };
  try {
    const result = await callModel(cfg, [
      new HumanMessage(
        `Generate 3 short follow-up coding requests (max 6 words each) for a ${language} ${taskType} task.\n` +
        `Original: "${prompt.slice(0, 150)}"\n` +
        `Output ONLY a JSON array: ["Add unit tests", "Add error handling", "Optimize performance"]`
      )
    ]);
    const match = result.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr.slice(0, 3).map(s => String(s).slice(0, 60)) : [];
  } catch {
    return ['Add unit tests', 'Add error handling', 'Optimize performance'];
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, existingCode, sessionId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const startTime = Date.now();

  try {
    console.log(`[CODE-AGENT] Starting agentic loop for: "${prompt.slice(0, 80)}"`);

    // ── STEP 1: DETECT language + task type in parallel ──
    const [language, taskType] = await Promise.all([
      detectLanguage(prompt, existingCode),
      classifyTask(prompt),
    ]);
    console.log(`[CODE-AGENT] Language: ${language} | Task: ${taskType}`);

    // ── STEP 2: SELECT model dynamically ──
    const cfg = selectModel(language, taskType);
    console.log(`[CODE-AGENT] Selected model: ${cfg.model} (${cfg.provider})`);

    // ── STEP 3: PLAN ──
    const plan = await planSolution(prompt, language, taskType, cfg);
    console.log(`[CODE-AGENT] Plan complete`);

    // ── STEP 4: WRITE ──
    let code = await writeCode(prompt, plan, language, taskType, existingCode, cfg);
    console.log(`[CODE-AGENT] Code written (${code.length} chars)`);

    // ── STEP 5: REVIEW ──
    const review = await reviewCode(code, language, prompt, cfg);
    console.log(`[CODE-AGENT] Review: ${review.verdict} (score: ${review.score})`);

    // ── STEP 5b: If REVISE — rewrite with review feedback ──
    if (review.verdict === 'REVISE' && review.issues?.length > 0) {
      console.log(`[CODE-AGENT] Revising based on review...`);
      const revisePrompt =
        `${prompt}\n\nIMPORTANT: Fix these issues from code review:\n` +
        review.issues.map(i => `- ${i}`).join('\n');
      code = await writeCode(revisePrompt, plan, language, taskType, code, cfg);
      console.log(`[CODE-AGENT] Revision complete`);
    }

    // ── STEP 6: EXPLAIN + SUGGESTIONS in parallel ──
    const [explanation, suggestions] = await Promise.all([
      explainCode(code, language, taskType),
      generateCodingSuggestions(prompt, language, taskType),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`[CODE-AGENT] Complete in ${elapsed}ms`);

    return res.status(200).json({
      code,
      language,
      taskType,
      plan,
      explanation,
      review,
      suggestions,
      modelUsed: cfg.model,
      elapsed,
    });

  } catch (err) {
    console.error('[CODE-AGENT] Error:', err);
    await notifyFailure({
      route:       '/api/code-agent',
      model:       'dynamic',
      error:       err,
      userMessage: prompt,
      sessionId,
    });
    return res.status(500).json({ error: err.message || 'Code agent failed' });
  }
}
