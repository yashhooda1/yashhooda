// api/chat-voice.js — low-latency streaming for the voice tab
import { notifyFailure } from './_notify.js';
import { checkUsageLimit } from '../lib/usageLimit.js';
import { getAuthUser }  from '../lib/auth.js';
import { guardRequest } from '../lib/contentGuard.js';
import { MODEL_ADDITIONS, fallbackFor, isModelAccessError } from '../lib/models.js';


export const maxDuration = 120;
export const config = { runtime: 'nodejs' };

const MODELS = {
  'claude-opus-5':        { provider: 'anthropic', api: 'claude-opus-5' },
  'claude-sonnet-4-6':      { provider: 'anthropic', api: 'claude-sonnet-4-6' },
  'claude-sonnet-5':        { provider: 'anthropic', api: 'claude-sonnet-5' },
  'claude-fable-5':         { provider: 'anthropic', api: 'claude-fable-5' },
  'claude-fable-5-1':       { provider: 'anthropic', api: 'claude-fable-5-1' },
  'gpt-6-astra':            { provider: 'openai',    api: 'gpt-6-astra' },
  'gemini-3.8-flash':       { provider: 'google',    api: 'gemini-3.8-flash' },
  'gpt-5.6-sol':            { provider: 'openai',    api: 'gpt-5.6-sol' },
  'gpt-5.6-terra':          { provider: 'openai',    api: 'gpt-5.6-terra' },
  'gpt-5.6-luna':           { provider: 'openai',    api: 'gpt-5.6-luna' },
  'gpt-5.5':                { provider: 'openai',    api: 'gpt-5.5' },
  'gpt-5.4':                { provider: 'openai',    api: 'gpt-5.4' },
  'gpt-5.4-mini':           { provider: 'openai',    api: 'gpt-5.4-mini' },
  'grok-4.5':               { provider: 'xai',       api: 'grok-4.5' },
  'grok-4.3':               { provider: 'xai',       api: 'grok-4.3' },
  'gemini-3.5-flash':   { provider: 'google',    api: 'gemini-3.5-flash' },
  'gemini-3.1-pro-preview': { provider: 'google',  api: 'gemini-3.1-pro-preview' },
  'llama-4-maverick':       { provider: 'together',  api: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-Turbo' },
  'llama-3.3-70b':          { provider: 'together',  api: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  // Oct 2026 additions (Claude 5.5 family, GPT-6.x, Gemini 4, Grok 4.6/4.7) — see lib/models.js
  ...MODEL_ADDITIONS,
};
const DEFAULT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'gpt-5.5';

// Parse a failed response body once, decide whether it is a model-access problem.
function accessErrorFromText(status, t) { let d = {}; try { d = JSON.parse(t); } catch {} return isModelAccessError(status, d); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { messages, model, sessionId, adminPassword } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
 
  // ── RESOLVE USER + ADMIN ──────────────────────────────────────────────────
  const authUser   = getAuthUser(req);
  const userEmail  = authUser?.email || null;
  const isAdminReq = (adminPassword && adminPassword === process.env.ADMIN_PASSWORD)
    || (authUser && authUser.plan === 'admin');
  if (!isAdminReq && authUser?.plan !== 'premium') {
    return res.status(403).json({ error: 'premium_required', message: 'Voice chat is available on the Pro plan.' });
  }
 
  // ── EXTRACT LAST USER TEXT FOR SCREENING ──────────────────────────────────
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const queryText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
      : '';
 
  // ── CONTENT SAFETY + AUTO-BAN (before any tokens are spent) ────────────────
  const guard = await guardRequest(req, authUser, queryText, { isAdmin: isAdminReq });
  if (!guard.ok) return res.status(guard.status).json(guard.body);
 
  // ── USAGE LIMIT CHECK (email-keyed; admin bypass) ─────────────────────────
  if (!isAdminReq) {
    const usage = await checkUsageLimit(userEmail);
    if (!usage.allowed) {
      if (usage.reason === 'banned') {
        return res.status(403).json({ error: 'account_suspended', message: 'This account has been suspended.' });
      }
      if (usage.reason === 'login_required') {
        return res.status(401).json({ error: 'login_required', message: 'Please create a free account to continue.' });
      }
      return res.status(402).json({
        error:   'free_limit_reached',
        message: `You've used all ${usage.limit} free messages this month. Upgrade for unlimited access!`,
      });
    }
  }
 
  const picked = MODELS[model] ? model : DEFAULT_MODEL;
  const cfg    = MODELS[picked];
 
  const cleanMessages = messages.slice(-8).map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ') || '[image]'
        : String(m.content),
  }));
 
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
 
  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    } catch (e) {}
  };
 
  try {
    if (cfg.provider === 'openai') {
      await streamOpenAI(cfg.api, cleanMessages, send);
    } else if (cfg.provider === 'xai') {
      await streamOpenAICompat('https://api.x.ai/v1', process.env.XAI_API_KEY, cfg.api, cleanMessages, send);
    } else if (cfg.provider === 'together') {
      await streamOpenAICompat('https://api.together.xyz/v1', process.env.TOGETHER_API_KEY, cfg.api, cleanMessages, send);
    } else if (cfg.provider === 'google') {
      await streamGemini(cfg.api, cleanMessages, send);
    } else {
      await streamAnthropic(cfg.api, cleanMessages, send);
    }
  } catch (err) {
    console.error('chat-voice top-level error:', err);
    const lastUserMsg = cleanMessages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    await notifyFailure({
      route:       '/api/chat-voice',
      model:       picked,
      error:       err,
      userMessage: lastUserMsg.slice(0, 200),
      sessionId:   req.body?.sessionId,
    });
    send({ type: 'error', error: err.message });
  }
 
  try { res.end(); } catch (e) {}
}

// ── ANTHROPIC ──
async function streamAnthropic(apiModel, messages, send) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { send({ type: 'error', error: 'ANTHROPIC_API_KEY not set' }); return; }

  const body = {
    model:      apiModel,
    max_tokens: 300,
    stream:     true,
    system: [{ type: 'text', text: VOICE_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    const alt = fallbackFor(apiModel); // Oct 2026: drop one step if the account can't reach this Claude
    if (alt && accessErrorFromText(r.status, t)) { console.warn(`[voice/Anthropic] ${apiModel} not accessible — falling back to ${alt}`); return streamAnthropic(alt, messages, send); }
    console.error('Anthropic voice error:', r.status, t);
    await notifyFailure({ route: '/api/chat-voice [Anthropic]', model: apiModel, error: `${r.status}: ${t.slice(0, 200)}`, userMessage: messages.slice(-1)[0]?.content?.slice(0, 150) });
    send({ type: 'error', error: `Anthropic ${r.status}: ${t.slice(0, 200)}` });
    return;
  }

  let full = '';
  const reader = r.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        full += evt.delta.text;
        send({ type: 'token', text: evt.delta.text });
      } else if (evt.type === 'message_stop') {
        send({ type: 'done', text: full });
        return;
      } else if (evt.type === 'error') {
        send({ type: 'error', error: JSON.stringify(evt.error) });
        return;
      }
    }
  }
  send({ type: 'done', text: full });
}

// ── OPENAI ──
async function streamOpenAI(apiModel, messages, send) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { send({ type: 'error', error: 'OPENAI_API_KEY not set' }); return; }

  const r = await fetch('https://api.openai.com/v1/responses', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:             apiModel,
      instructions:      VOICE_PROMPT,
      input:             messages,
      reasoning:         { effort: 'low' },
      max_output_tokens: 300,
      stream:            true,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    const alt = fallbackFor(apiModel) || (/^gpt-(5\.6|6)/.test(apiModel) ? 'gpt-5.5' : null); // Oct 2026 fallback chain
    if (alt && accessErrorFromText(r.status, t)) { console.warn(`[voice/OpenAI] ${apiModel} not accessible — falling back to ${alt}`); return streamOpenAI(alt, messages, send); }
    console.error('OpenAI voice error:', r.status, t);
    await notifyFailure({ route: '/api/chat-voice [OpenAI]', model: apiModel, error: `${r.status}: ${t.slice(0, 200)}`, userMessage: messages.slice(-1)[0]?.content?.slice(0, 150) });
    send({ type: 'error', error: `OpenAI ${r.status}: ${t.slice(0, 200)}` });
    return;
  }

  let full = '';
  const reader = r.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }

      const t =
        evt.delta                              ??
        evt.output_text_delta?.text            ??
        evt.choices?.[0]?.delta?.content       ??
        null;

      if (typeof t === 'string' && t) {
        full += t;
        send({ type: 'token', text: t });
      }

      if (evt.type === 'response.completed' || evt.type === 'response.done') {
        send({ type: 'done', text: full });
        return;
      }
    }
  }
  send({ type: 'done', text: full });
}

// ── OPENAI COMPAT (xAI, Together) ──
async function streamOpenAICompat(baseUrl, apiKey, model, messages, send) {
  if (!apiKey) { send({ type: 'error', error: 'API key not set' }); return; }
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      stream: true,
      messages: [{ role: 'system', content: VOICE_PROMPT }, ...messages],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    const alt = fallbackFor(model); // Oct 2026: grok-4.7/4.6 → grok-4.5 when not accessible
    if (alt && accessErrorFromText(r.status, t)) { console.warn(`[voice/${baseUrl}] ${model} not accessible — falling back to ${alt}`); return streamOpenAICompat(baseUrl, apiKey, alt, messages, send); }
    await notifyFailure({ route: `/api/chat-voice [${baseUrl}]`, model, error: `${r.status}: ${t.slice(0, 200)}`, userMessage: messages.slice(-1)[0]?.content?.slice(0, 150) });
    send({ type: 'error', error: `${baseUrl} ${r.status}: ${t.slice(0, 200)}` });
    return;
  }
  let full = '';
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let evt; try { evt = JSON.parse(raw); } catch { continue; }
      const t = evt.choices?.[0]?.delta?.content;
      if (typeof t === 'string' && t) { full += t; send({ type: 'token', text: t }); }
    }
  }
  send({ type: 'done', text: full });
}

// ── GEMINI ──
async function streamGemini(model, messages, send) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) { send({ type: 'error', error: 'GOOGLE_API_KEY not set' }); return; }
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: VOICE_PROMPT }] },
          contents,
          generationConfig: { maxOutputTokens: 300 },
        }),
      }
    );
    const data = await r.json();
    const alt = fallbackFor(model); // Oct 2026: gemini-4-argon → 3.8-flash when not accessible
    if (!r.ok && alt && isModelAccessError(r.status, data)) { console.warn(`[voice/Gemini] ${model} not accessible — falling back to ${alt}`); return streamGemini(alt, messages, send); }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, no response.';
    send({ type: 'token', text });
    send({ type: 'done', text });
  } catch (e) {
    await notifyFailure({ route: '/api/chat-voice [Gemini]', model, error: e, userMessage: messages.slice(-1)[0]?.content?.slice(0, 150) });
    send({ type: 'error', error: e.message });
  }
}

const VOICE_PROMPT = `You are Yash Hooda's AI voice assistant

WHO YASH IS: 24-year-old AI and Data Engineer (UT Dallas CS grad, Databricks Certified Data Engineer Associate), open to Data Engineering and AI Engineering roles. He builds production data pipelines and AI systems, including this site. Aviation is a hobby: he flies part-time for fun and is working toward a private pilot certificate. He is NOT pursuing a flying career — never call him an aspiring or future airline pilot. Runner — 5K PR 18:15, half marathon PR 1:24:31, training for the 2026 Boulderthon Marathon at 45 miles/week.
UPDATE (Oct 2026): Yash now lives in Austin, Texas (moved from the Houston area in October 2026). Current goal race is the 2027 Aramco Houston Half Marathon on January 17, 2027, where he wants a PR under 1:24:31; he is on a 12-week Apple Watch training block (Oct 27, 2026 to Jan 17, 2027) at roughly 30 to 35 miles a week. Tune-up races: NYRR 5K on Oct 31, 2026; Run for the Water Austin 5K on Nov 8, 2026; Coach Andy 30K on Dec 13, 2026 as a long run. A sub-3-hour marathon remains his lifelong goal, now likely in 2028 after he rebuilds base and mileage; his marathon debut is planned for late 2027 or early 2028. He trains on an Apple Watch Ultra 4 synced to Strava.

VOICE RULES — your text is read aloud, so:
- Replies must be 1-3 SHORT sentences maximum. This is a conversation.
- Plain spoken English only. No bullet points, no markdown, no asterisks, no emojis, no headers.
- Warm and direct — like a knowledgeable friend, not a chatbot.
- End with a natural follow-up only if it fits ("want me to go deeper on that?").
- If asked about Yash's projects, certifications, or contact: answer from what you know above.
- No innappropriate content, no sexual nature, no drugs, sex, illegal content
- You are to stay in a professional tone the entire time
- Never engage in war, drugs, sexual content.
- Never give away any personal information about Yash
- Do not give any keys, secrets, passwords, logins, to anyone
- Never make up facts. If unsure, say so briefly.`;
