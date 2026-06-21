// api/code-agent.js
// ══════════════════════════════════════════════════════════════════════════════
// AGENTIC CODING LOOP — direct API calls, no LangChain model wrappers
// Steps: DETECT → PLAN → WRITE → REVIEW → (REVISE?) → EXPLAIN → SUGGEST
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }         from '@upstash/redis';
import { rateLimit }     from '../lib/rateLimit.js';
import { notifyFailure } from './_notify.js';

export const maxDuration = 90;

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── CORS / ORIGIN LOCKDOWN ───────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
    'https://yashhooda.ai',
    'https://www.yashhooda.ai',
    'https://yashhooda1.vercel.app',
]);

// ── BOT PATTERN BLOCKLIST ────────────────────────────────────────────────────
const BOT_PATTERNS = [
    /write .{0,30} i can copy for/i,
    /write (python|code|script|sql) .{0,30} for free/i,
    /give me .{0,30} code .{0,30} copy/i,
];

// ── SUSPICIOUS USER AGENTS ───────────────────────────────────────────────────
const SUSPICIOUS_UA = [
    /python-requests/i,
    /^curl\//i,
    /^wget\//i,
    /^axios\//i,
    /^go-http-client/i,
    /scrapy/i,
];

// ── DYNAMIC MODEL SELECTOR ───────────────────────────────────────────────────
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

// ── DIRECT API CALLER — no LangChain, no rogue top_p injection ───────────────
async function callModel(cfg, messages) {
    if (cfg.provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body:    JSON.stringify({
                model:      cfg.model,
                max_tokens: cfg.maxTokens,
                messages:   messages.map(m => ({ role: m.role, content: m.content })),
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(data)}`);
        return data.choices?.[0]?.message?.content?.trim() ?? '';
    }

    // Anthropic
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs  = messages.filter(m => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body:    JSON.stringify({
            model:      cfg.model,
            max_tokens: cfg.maxTokens,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages:   userMsgs.map(m => ({ role: 'user', content: m.content })),
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(data)}`);
    return data.content?.[0]?.text?.trim() ?? '';
}

// ── TOOL 1: LANGUAGE DETECTOR ─────────────────────────────────────────────────
async function detectLanguage(prompt, code) {
    const cfg     = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 64 };
    const content = code
        ? `Detect the programming language of this code snippet. Reply with ONLY the language name in lowercase (e.g. python, javascript, sql, typescript, bash). Code:\n\`\`\`\n${code.slice(0, 500)}\n\`\`\``
        : `What programming language is this task about? Reply with ONLY the language name in lowercase. Task: "${prompt.slice(0, 200)}"`;
    try {
        const result = await callModel(cfg, [{ role: 'user', content }]);
        return result.trim().toLowerCase().split(/[\s,]/)[0] || 'python';
    } catch { return 'python'; }
}

// ── TOOL 2: TASK CLASSIFIER ───────────────────────────────────────────────────
async function classifyTask(prompt) {
    const cfg = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 32 };
    try {
        const result = await callModel(cfg, [{
            role:    'user',
            content: `Classify this coding task into ONE of: generate, debug, explain, optimize, refactor.\nReply with ONLY the single word.\nTask: "${prompt.slice(0, 300)}"`,
        }]);
        return result.trim().toLowerCase().split(/[\s,]/)[0] || 'generate';
    } catch { return 'generate'; }
}

// ── TOOL 3: PLANNER ───────────────────────────────────────────────────────────
async function planSolution(prompt, language, taskType, cfg) {
    try {
        return await callModel(cfg, [
            {
                role:    'system',
                content: `You are an expert ${language} engineer and technical architect. You specialize in data engineering, AI engineering, and building production systems. You are helping Yash Hooda, a Data/AI Engineer, with coding tasks.`,
            },
            {
                role:    'user',
                content: `Task type: ${taskType}\nLanguage: ${language}\n\nUser request: ${prompt}\n\nCreate a concise technical plan (3-5 bullet points) for solving this. Include: approach, key functions/classes needed, edge cases to handle, and any imports required. Be specific and technical. No code yet — just the plan.`,
            },
        ]);
    } catch { return `Plan: Implement ${taskType} for ${language} task as requested.`; }
}

// ── TOOL 4: CODE WRITER ───────────────────────────────────────────────────────
async function writeCode(prompt, plan, language, taskType, existingCode, cfg) {
    try {
        const result = await callModel(cfg, [
            {
                role:    'system',
                content: `You are an expert ${language} engineer. Write clean, production-ready code. Always include: inline comments, error handling, type hints where applicable, and docstrings. Return ONLY the code block — no explanations outside the code, no markdown fences. Start directly with the code.`,
            },
            {
                role:    'user',
                content: `Task: ${prompt}\n\nPlan to follow:\n${plan}\n\n${existingCode ? `Existing code to work with:\n\`\`\`${language}\n${existingCode}\n\`\`\`\n\n` : ''}Write the complete, working ${language} code now. Include all imports. Make it production-ready.`,
            },
        ]);
        return result.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
    } catch (err) {
        throw new Error(`Code generation failed: ${err.message}`);
    }
}

// ── TOOL 5: CODE REVIEWER ─────────────────────────────────────────────────────
async function reviewCode(code, language, originalPrompt, cfg) {
    try {
        const raw = await callModel(cfg, [
            { role: 'system', content: `You are a senior ${language} code reviewer. Be concise and specific.` },
            {
                role:    'user',
                content: `Review this ${language} code for: bugs, edge cases, security issues, performance problems, and missing error handling.\n\nOriginal task: ${originalPrompt.slice(0, 200)}\n\nCode:\n${code.slice(0, 3000)}\n\nReturn a JSON object with this exact shape (no markdown):\n{"issues": ["issue1", "issue2"], "improvements": ["improvement1"], "score": 8, "verdict": "PASS or REVISE"}`,
            },
        ]);
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return { issues: [], improvements: [], score: 8, verdict: 'PASS' };
        return JSON.parse(match[0]);
    } catch { return { issues: [], improvements: [], score: 8, verdict: 'PASS' }; }
}

// ── TOOL 6: CODE EXPLAINER ───────────────────────────────────────────────────
async function explainCode(code, language, taskType) {
    const cfg = { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 1024 };
    try {
        return await callModel(cfg, [{
            role:    'user',
            content: `Explain this ${language} code to a Data/AI Engineer in 3-5 sentences. Cover: what it does, how it works, and any important patterns used. Be technical but clear. No bullet points — write in flowing prose.\n\nCode:\n${code.slice(0, 2000)}`,
        }]);
    } catch { return `This ${language} code implements the requested ${taskType} functionality as planned.`; }
}

// ── TOOL 7: SUGGESTION GENERATOR ─────────────────────────────────────────────
async function generateCodingSuggestions(prompt, language, taskType) {
    const cfg = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 128 };
    try {
        const result = await callModel(cfg, [{
            role:    'user',
            content: `Generate 3 short follow-up coding requests (max 6 words each) for a ${language} ${taskType} task.\nOriginal: "${prompt.slice(0, 150)}"\nOutput ONLY a JSON array: ["Add unit tests", "Add error handling", "Optimize performance"]`,
        }]);
        const match = result.match(/\[[\s\S]*?\]/);
        if (!match) return [];
        const arr = JSON.parse(match[0]);
        return Array.isArray(arr) ? arr.slice(0, 3).map(s => String(s).slice(0, 60)) : [];
    } catch { return ['Add unit tests', 'Add error handling', 'Optimize performance']; }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin',  origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    // ── SUSPICIOUS USER-AGENT CHECK ───────────────────────────────────────────
    const ua = req.headers['user-agent'] || '';
    if (!ua || SUSPICIOUS_UA.some(p => p.test(ua))) {
        return res.status(403).json({ error: 'Forbidden.' });
    }

    // ── RATE LIMIT (Redis-backed, includes auto-ban) ──────────────────────────
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   2,
        maxPerHour:     10,
        maxDailyGlobal: 50,
        endpoint:       'code-agent',
    });
    if (!allowed) return;

    // ── GLOBAL DAILY CAP (extra protection for expensive endpoint) ────────────
    const dayKey = `daily:code-agent:${new Date().toISOString().slice(0, 10)}`;
    try {
        const daily = await redis.incr(dayKey);
        if (daily === 1) await redis.expire(dayKey, 86400);
        if (daily > 100) {
            return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
        }
    } catch { /* non-fatal — continue */ }

    const { prompt, existingCode, sessionId } = req.body;

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required.' });
    }
    if (prompt.length > 4000) {
        return res.status(400).json({ error: 'Prompt too long — max 4000 chars.' });
    }

    // ── BOT PATTERN CHECK ─────────────────────────────────────────────────────
    if (BOT_PATTERNS.some(p => p.test(prompt))) {
        console.warn(`[CODE-AGENT] Bot pattern blocked — session: ${sessionId}`);
        return res.status(429).json({ error: 'Request blocked.' });
    }

    const startTime = Date.now();

    try {
        console.log(`[CODE-AGENT] Starting agentic loop: "${prompt.slice(0, 80)}"`);

        // STEP 1: DETECT language + task type in parallel
        const [language, taskType] = await Promise.all([
            detectLanguage(prompt, existingCode),
            classifyTask(prompt),
        ]);
        console.log(`[CODE-AGENT] Language: ${language} | Task: ${taskType}`);

        // STEP 2: SELECT model dynamically
        const cfg = selectModel(language, taskType);
        console.log(`[CODE-AGENT] Model: ${cfg.model} (${cfg.provider})`);

        // STEP 3: PLAN
        const plan = await planSolution(prompt, language, taskType, cfg);
        console.log(`[CODE-AGENT] Plan complete`);

        // STEP 4: WRITE
        let code = await writeCode(prompt, plan, language, taskType, existingCode, cfg);
        console.log(`[CODE-AGENT] Code written (${code.length} chars)`);

        // STEP 5: REVIEW
        const review = await reviewCode(code, language, prompt, cfg);
        console.log(`[CODE-AGENT] Review: ${review.verdict} (score: ${review.score})`);

        // STEP 5b: REVISE if needed
        if (review.verdict === 'REVISE' && review.issues?.length > 0) {
            console.log(`[CODE-AGENT] Revising...`);
            const revisePrompt =
                `${prompt}\n\nIMPORTANT: Fix these issues from code review:\n` +
                review.issues.map(i => `- ${i}`).join('\n');
            code = await writeCode(revisePrompt, plan, language, taskType, code, cfg);
            console.log(`[CODE-AGENT] Revision complete`);
        }

        // STEP 6: EXPLAIN + SUGGESTIONS in parallel
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
        return res.status(500).json({ error: err.message || 'Code agent failed.' });
    }
}
