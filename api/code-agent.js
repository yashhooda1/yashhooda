// api/code-agent.js
// Full agentic coding loop with LangChain + dynamic model selection
// Steps: DETECT → PLAN → WRITE → REVIEW → EXPLAIN

import { notifyFailure } from './_notify.js';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';

export const maxDuration = 90;

// ── DYNAMIC MODEL SELECTOR ──────────────────────────────────────────────────
function selectModel(language, taskType) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;

  // Data engineering, Python, SQL, PySpark → Claude (Yash's domain)
  if (['python', 'sql', 'pyspark', 'bash', 'r'].includes(language?.toLowerCase())) {
    return new ChatAnthropic({
      apiKey: anthropicKey,
      model: 'claude-opus-4-8',
      maxTokens: 4096,
      topP: 1,
    });
  }

  // JavaScript, TypeScript, React, Node → GPT
  if (['javascript', 'typescript', 'jsx', 'tsx', 'node'].includes(language?.toLowerCase())) {
    return new ChatOpenAI({
      apiKey: openaiKey,
      model: 'gpt-4o',
      maxTokens: 4096,
    });
  }

  // Debugging tasks → Claude with extended thinking
  if (taskType === 'debug') {
    return new ChatAnthropic({
      apiKey: anthropicKey,
      model: 'claude-opus-4-8',
      maxTokens: 8000,
      topP: 1,
    });
  }

  // Default → Claude Sonnet (fast + capable)
  return new ChatAnthropic({
    apiKey: anthropicKey,
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    topP: 1,
  });
}

// ── TOOL 1: LANGUAGE DETECTOR ───────────────────────────────────────────────
async function detectLanguage(prompt, code) {
  const model = new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 64,
    topP: 1,
  });

  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

  const content = code
    ? `Detect the programming language of this code snippet. Reply with ONLY the language name in lowercase (e.g. python, javascript, sql, typescript, bash, rust, go, java). Code:\n\`\`\`\n${code.slice(0, 500)}\n\`\`\``
    : `What programming language is this task about? Reply with ONLY the language name in lowercase. Task: "${prompt.slice(0, 200)}"`;

  try {
    const result = await chain.invoke([new HumanMessage(content)]);
    return result.trim().toLowerCase().split(/[\s,]/)[0] || 'python';
  } catch {
    return 'python';
  }
}

// ── TOOL 2: TASK CLASSIFIER ─────────────────────────────────────────────────
async function classifyTask(prompt) {
  const model  = new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 32,
    topP: 1,
  });
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

  try {
    const result = await chain.invoke([
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
async function planSolution(prompt, language, taskType, model) {
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

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
    return await chain.invoke([systemMsg, humanMsg]);
  } catch (err) {
    return `Plan: Implement ${taskType} for ${language} task as requested.`;
  }
}

// ── TOOL 4: CODE WRITER ─────────────────────────────────────────────────────
async function writeCode(prompt, plan, language, taskType, existingCode, model) {
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

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
    const result = await chain.invoke([systemMsg, humanMsg]);
    // Strip markdown fences if model added them anyway
    return result
      .replace(/^```[\w]*\n?/m, '')
      .replace(/```$/m, '')
      .trim();
  } catch (err) {
    throw new Error(`Code generation failed: ${err.message}`);
  }
}

// ── TOOL 5: CODE REVIEWER ───────────────────────────────────────────────────
async function reviewCode(code, language, originalPrompt, model) {
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

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
    const raw    = await chain.invoke([systemMsg, humanMsg]);
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) return { issues: [], improvements: [], score: 8, verdict: 'PASS' };
    return JSON.parse(match[0]);
  } catch {
    return { issues: [], improvements: [], score: 8, verdict: 'PASS' };
  }
}

// ── TOOL 6: CODE EXPLAINER ──────────────────────────────────────────────────
async function explainCode(code, language, plan, taskType) {
  const model = new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6',
    maxTokens: 1024,
    topP: 1,
  });
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

  const humanMsg = new HumanMessage(
    `Explain this ${language} code to a Data/AI Engineer in 3-5 sentences. ` +
    `Cover: what it does, how it works, and any important patterns used. ` +
    `Be technical but clear. No bullet points — write in flowing prose.\n\n` +
    `Code:\n${code.slice(0, 2000)}`
  );

  try {
    return await chain.invoke([humanMsg]);
  } catch {
    return `This ${language} code implements the requested ${taskType} functionality as planned.`;
  }
}

// ── TOOL 7: SUGGESTION GENERATOR ────────────────────────────────────────────
async function generateCodingSuggestions(prompt, language, taskType) {
  const model = new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 128,
    topP: 1,
  });
  const parser = new StringOutputParser();
  const chain  = model.pipe(parser);

  try {
    const result = await chain.invoke([
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
    const model = selectModel(language, taskType);
    const modelName = model.model || model.modelName || 'claude-opus-4-8';
    console.log(`[CODE-AGENT] Selected model: ${modelName}`);

    // ── STEP 3: PLAN ──
    const plan = await planSolution(prompt, language, taskType, model);
    console.log(`[CODE-AGENT] Plan complete`);

    // ── STEP 4: WRITE ──
    let code = await writeCode(prompt, plan, language, taskType, existingCode, model);
    console.log(`[CODE-AGENT] Code written (${code.length} chars)`);

    // ── STEP 5: REVIEW ──
    const review = await reviewCode(code, language, prompt, model);
    console.log(`[CODE-AGENT] Review: ${review.verdict} (score: ${review.score})`);

    // ── STEP 5b: If REVISE — rewrite with review feedback ──
    if (review.verdict === 'REVISE' && review.issues.length > 0) {
      console.log(`[CODE-AGENT] Revising based on review...`);
      const revisePrompt = `${prompt}\n\nIMPORTANT: Fix these issues from code review:\n${review.issues.map(i => `- ${i}`).join('\n')}`;
      code = await writeCode(revisePrompt, plan, language, taskType, code, model);
      console.log(`[CODE-AGENT] Revision complete`);
    }

    // ── STEP 6: EXPLAIN + SUGGESTIONS in parallel ──
    const [explanation, suggestions] = await Promise.all([
      explainCode(code, language, plan, taskType),
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
      modelUsed: modelName,
      elapsed,
    });

  } catch (err) {
    console.error('[CODE-AGENT] Error:', err);
    await notifyFailure({
      route: '/api/code-agent',
      model: 'dynamic',
      error: err,
      userMessage: prompt,
      sessionId,
    });
    return res.status(500).json({ error: err.message || 'Code agent failed' });
  }
}
