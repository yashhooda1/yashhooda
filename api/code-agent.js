// api/code-agent.js
// ══════════════════════════════════════════════════════════════════════════════
// AGENTIC CODING LOOP — direct API calls, no LangChain model wrappers
// Steps: DETECT → PLAN → WRITE → REVIEW → (REVISE?) → EXPLAIN → SUGGEST
//
// HARDENED:
//   • CODE_AGENT_OFF kill switch (env var, instant disable, no code change)
//   • Auth gate — admin password OR verified login required
//   • Redis IP + email banlist enforcement
//   • [TRACE] abuse logging
//   • Tighter rate limits + lower global daily cap
//   • Internal hard timeout so runs can't pin the function at 120s
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }         from '@upstash/redis';
import { rateLimit }     from '../lib/rateLimit.js';
import { notifyFailure } from './_notify.js';
import { getAuthUser }   from '../lib/auth.js';
import { guardRequest } from '../lib/contentGuard.js';
import { checkKillSwitch } from '../lib/killSwitch.js';

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
    /build an agent, make no mistakes/i,
    /build me an ai agent/i,
    /build an agent/i,
    /create an ai agent/i,
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

// ── MALICIOUS-CODE REQUEST BLOCKLIST ─────────────────────────────────────────
// The agent must not be turned into a malware/exploit generator. These patterns
// trigger a hard refusal before any model call is made.
const DISALLOWED_TASK_PATTERNS = [
    /\b(ransomware|keylogger|rootkit|botnet|trojan|spyware|worm)\b/i,
    /\b(ddos|dos attack|denial of service)\b/i,
    /\bcredential (stealer|harvest|dump)/i,
    /\b(sql injection|xss payload|csrf exploit)\b.*\b(attack|exploit|bypass)\b/i,
    /\bbypass (auth|authentication|login|2fa|mfa|paywall)\b/i,
    /\bcrack (password|license|software|wifi)\b/i,
    /\b(phishing|spoof) (page|site|email|kit)\b/i,
    /\bscrape .{0,30}(without permission|bypass rate)/i,
    /\bexfiltrat/i,
    /\bprivilege escalation\b/i,
    /\breverse shell\b/i,
    /\bhack(ing)? (into|someone|a (server|account|system|network))/i,
    // ── NO AGENT-BUILDING ──
    /\b(build|create|make|develop|write|design|code|generate)\b.{0,30}\b(ai |autonomous |llm |chat ?)?(agent|agents|agentic|chatbot|bot)\b/i,
    /\b(agentic (framework|loop|system|workflow|pipeline))\b/i,
    /\b(multi[- ]?agent|agent swarm|agent orchestrat)/i,
    /\b(langchain|autogpt|crewai|babyagi|auto-?gpt)\b.{0,30}\b(agent|build|create)/i,
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

// ── PROMISE TIMEOUT WRAPPER ──────────────────────────────────────────────────
// Stops any single model call from hanging the whole function toward the 120s
// platform limit. Rejects after `ms` so the handler fails fast and clean.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
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
                content: `You are an expert ${language} engineer. Write clean, production-ready code. Always include: inline comments, error handling, type hints where applicable, and docstrings. You only write legitimate, lawful code — never malware, exploits, scrapers that bypass protections, or anything designed to harm or defraud. You do not build AI agents, autonomous agents, agentic systems, or chatbots of any kind. Return ONLY the code block — no explanations outside the code, no markdown fences. Start directly with the code.`,
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
                content: `You are an expert ${language} engineer. Write clean, production-ready code. Always include: inline comments, error handling, type hints where applicable, and docstrings. You only write legitimate, lawful code — never malware, exploits, scrapers that bypass protections, or anything designed to harm or defraud. Return ONLY the code block — no explanations outside the code, no markdown fences. Start directly with the code.`,
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    // ── KILL SWITCH — flip env CODE_AGENT_OFF=on in Vercel to disable instantly ─
    if (process.env.CODE_AGENT_OFF === 'on') {
        return res.status(503).json({ error: 'Code agent is temporarily disabled.' });
    }

    // ── ABUSE TRACE LOG ───────────────────────────────────────────────────────
    const traceIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    console.warn(`[TRACE] ip=${traceIp} ua="${req.headers['user-agent'] || ''}" path=${req.url || ''}`);

    // ── HARD IP BAN CHECK ─────────────────────────────────────────────────────
    try {
        const ipBanned = await redis.sismember('banned:ips', traceIp);
        if (ipBanned === 1) return res.status(403).json({ error: 'Access denied.' });
    } catch { /* fail open on redis hiccup */ }

    // ── SUSPICIOUS USER-AGENT CHECK ───────────────────────────────────────────
    const ua = req.headers['user-agent'] || '';
    if (!ua || SUSPICIOUS_UA.some(p => p.test(ua))) {
        return res.status(403).json({ error: 'Forbidden.' });
    }

    const { prompt, existingCode, sessionId, adminPassword } = req.body || {};

    // ── AUTH GATE — admin password OR verified logged-in user only ────────────
    // This is the expensive endpoint; never leave it open to anonymous callers.
    const authUser = getAuthUser(req);
    const isAdmin  = adminPassword && process.env.ADMIN_PASSWORD && adminPassword === process.env.ADMIN_PASSWORD;
    const guard = await guardRequest(req, authUser, prompt, { isAdmin });
    if (!guard.ok) return res.status(guard.status).json(guard.body);
    const isAdminReq = adminPassword && adminPassword === process.env.ADMIN_PASSWORD;
    const ks = await checkKillSwitch('code-agent', isAdminReq);
    if (!ks.ok) return res.status(ks.status).json(ks.body);

    if (!isAdmin) {
        if (!authUser) {
            return res.status(401).json({ error: 'login_required', message: 'Please log in to use the code agent.' });
        }
        if (authUser.verified === false) {
            return res.status(403).json({ error: 'email_unverified', message: 'Please verify your email to use the code agent.' });
        }
        // Banned email check for logged-in users
        try {
            const emailBanned = await redis.sismember('banned:emails', String(authUser.email || '').toLowerCase().trim());
            if (emailBanned === 1) return res.status(403).json({ error: 'account_suspended' });
        } catch { /* fail open */ }
    }

    // ── RATE LIMIT (Redis-backed, includes auto-ban) ──────────────────────────
    const allowed = await rateLimit(req, res, {
        maxPerMinute:   2,
        maxPerHour:     8,
        maxDailyGlobal: 40,
        endpoint:       'code-agent',
    });
    if (!allowed) return;

    // ── GLOBAL DAILY CAP (extra protection for expensive endpoint) ────────────
    const dayKey = `daily:code-agent:${new Date().toISOString().slice(0, 10)}`;
    try {
        const daily = await redis.incr(dayKey);
        if (daily === 1) await redis.expire(dayKey, 86400);
        if (daily > 60) {
            return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
        }
    } catch { /* non-fatal — continue */ }

    // ── INPUT VALIDATION ──────────────────────────────────────────────────────
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

    // ── MALICIOUS-CODE REQUEST CHECK ──────────────────────────────────────────
    if (!isAdmin && DISALLOWED_TASK_PATTERNS.some(p => p.test(prompt))) {
        console.warn(`[CODE-AGENT] Disallowed task blocked — ip=${traceIp} session=${sessionId}`);
        return res.status(403).json({
            error: 'disallowed_request',
            message: "I can't help build that. The code agent only assists with legitimate, lawful engineering tasks.",
        });
    }

    const startTime = Date.now();

    // Internal ceiling per model call — keeps total run well under the 90s maxDuration
    const STEP_TIMEOUT_MS = 25000;

    try {
        console.log(`[CODE-AGENT] Starting agentic loop: "${prompt.slice(0, 80)}"`);

        // STEP 1: DETECT language + task type in parallel
        const [language, taskType] = await withTimeout(
            Promise.all([ detectLanguage(prompt, existingCode), classifyTask(prompt) ]),
            STEP_TIMEOUT_MS, 'detect/classify'
        );
        console.log(`[CODE-AGENT] Language: ${language} | Task: ${taskType}`);

        // STEP 2: SELECT model dynamically
        const cfg = selectModel(language, taskType);
        console.log(`[CODE-AGENT] Model: ${cfg.model} (${cfg.provider})`);

        // STEP 3: PLAN
        const plan = await withTimeout(
            planSolution(prompt, language, taskType, cfg),
            STEP_TIMEOUT_MS, 'plan'
        );
        console.log(`[CODE-AGENT] Plan complete`);

        // STEP 4: WRITE
        let code = await withTimeout(
            writeCode(prompt, plan, language, taskType, existingCode, cfg),
            STEP_TIMEOUT_MS, 'write'
        );
        console.log(`[CODE-AGENT] Code written (${code.length} chars)`);

        // STEP 5: REVIEW
        const review = await withTimeout(
            reviewCode(code, language, prompt, cfg),
            STEP_TIMEOUT_MS, 'review'
        );
        console.log(`[CODE-AGENT] Review: ${review.verdict} (score: ${review.score})`);

        // STEP 5b: REVISE if needed (single pass only — no unbounded loops)
        if (review.verdict === 'REVISE' && review.issues?.length > 0) {
            console.log(`[CODE-AGENT] Revising...`);
            const revisePrompt =
                `${prompt}\n\nIMPORTANT: Fix these issues from code review:\n` +
                review.issues.map(i => `- ${i}`).join('\n');
            code = await withTimeout(
                writeCode(revisePrompt, plan, language, taskType, code, cfg),
                STEP_TIMEOUT_MS, 'revise'
            );
            console.log(`[CODE-AGENT] Revision complete`);
        }

        // STEP 6: EXPLAIN + SUGGESTIONS in parallel
        const [explanation, suggestions] = await withTimeout(
            Promise.all([
                explainCode(code, language, taskType),
                generateCodingSuggestions(prompt, language, taskType),
            ]),
            STEP_TIMEOUT_MS, 'explain/suggest'
        );

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
        }).catch(() => {});
        return res.status(500).json({ error: 'Code agent failed — please try again.' });
    }
}
