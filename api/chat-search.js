// api/chat-search.js
// Vercel serverless function — Claude OR GPT with web search
// maxDuration = 60 solves the 504 timeout (Vercel Pro supports up to 300s)\

import { getAuthUser }  from '../lib/auth.js';
import { guardRequest } from '../lib/contentGuard.js';
import { checkUsageLimit } from '../lib/usageLimit.js';

export const maxDuration = 60; // seconds — requires Vercel Pro (you already have it)

// ── MODEL REGISTRY ── keep in sync with chat.js
const MODELS = {
  'claude-opus-4-8':        { provider: 'anthropic', api: 'claude-opus-4-8' },
  'claude-sonnet-4-6':      { provider: 'anthropic', api: 'claude-sonnet-4-6' },
  'gpt-5.5':                { provider: 'openai',    api: 'gpt-5.5' },
  'gpt-5.4':                { provider: 'openai',    api: 'gpt-5.4' },
  'gpt-5.4-mini':           { provider: 'openai',    api: 'gpt-5.4-mini' },
  'grok-3':                 { provider: 'xai',       api: 'grok-3' },
  'grok-3-mini':            { provider: 'xai',       api: 'grok-3-mini' },
  'gemini-2.5-flash':       { provider: 'google',    api: 'gemini-2.5-flash-preview-05-20' },
  'gemini-2.5-pro':         { provider: 'google',    api: 'gemini-2.5-pro-preview-06-05' },
  'llama-4-maverick':       { provider: 'together',  api: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-Turbo' },
  'llama-3.3-70b':          { provider: 'together',  api: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
};
const DEFAULT_MODEL = 'claude-opus-4-8';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, sessionId, model, adminPassword } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // ── RESOLVE USER + CONTENT SAFETY (before stream headers) ──
  const authUser   = getAuthUser(req);
  const isAdminReq = adminPassword && adminPassword === process.env.ADMIN_PASSWORD;

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const queryText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
      : '';

  const guard = await guardRequest(req, authUser, queryText, { isAdmin: isAdminReq });
  if (!guard.ok) return res.status(guard.status).json(guard.body);

  if (!isAdminReq) {
  const usage = await checkUsageLimit(authUser?.email || null);
  if (!usage.allowed) {
    if (usage.reason === 'login_required')
      return res.status(401).json({ error: 'login_required', message: 'Please create a free account to continue.' });
    return res.status(402).json({ error: 'free_limit_reached', message: `You've used all ${usage.limit} free messages this month.` });
  }
}

  const picked = MODELS[model] ? model : DEFAULT_MODEL;
  const cfg = MODELS[picked];

  // ── Build a lean message list (drop heavy image content to save tokens) ──
  const cleanMessages = messages.slice(-10).map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b.type === 'text').map(b => b.text).join(' ') || '[image]'
        : String(m.content)
  }));

  // ── Set up SSE streaming so the browser gets tokens as they arrive ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush(); // force flush for Vercel edge buffering
  };

  try {
    // ════════════════════════════════════════════════════════
    // NON-ANTHROPIC PATH: xAI, Google, Together — simple completion, no streaming
    if (cfg.provider === 'xai' || cfg.provider === 'google' || cfg.provider === 'together') {
      sendEvent({ type: 'searching', message: '🤖 Generating response…' });
      let text = '';
      try {
        if (cfg.provider === 'xai' || cfg.provider === 'together') {
          const baseUrl = cfg.provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.together.xyz/v1';
          const key     = cfg.provider === 'xai' ? process.env.XAI_API_KEY : process.env.TOGETHER_API_KEY;
          const r = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: cfg.api, max_tokens: 1024, messages: [{ role: 'system', content: buildSystemPrompt() }, ...cleanMessages] }),
          });
          const d = await r.json();
          text = d.choices?.[0]?.message?.content || '(no response)';
        } else {
          // Google Gemini
          const key = process.env.GOOGLE_API_KEY;
          const gemContents = cleanMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.api}:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: buildSystemPrompt() }] }, contents: gemContents, generationConfig: { maxOutputTokens: 1024 } }),
          });
          const d = await r.json();
          text = d.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
        }
      } catch (e) { text = 'Error: ' + e.message; }
      sendEvent({ type: 'done', text });
      res.end();
      return;
    }
    // OPENAI PATH (GPT-5.x): Responses API + web_search tool.
    // Non-streaming call, then push the finished answer over SSE.
    // ════════════════════════════════════════════════════════
    if (cfg.provider === 'openai') {
      sendEvent({ type: 'searching', message: '🔍 Searching the web…' });

      const oaiRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: cfg.api,
          instructions: buildSystemPrompt(),
          input: cleanMessages,
          tools: [{ type: 'web_search' }],
          reasoning: { effort: 'medium' },
          max_output_tokens: 4096,
        }),
      });

      const data = await oaiRes.json();
      if (!oaiRes.ok) {
        console.error('OpenAI API error:', oaiRes.status, JSON.stringify(data));
        sendEvent({ type: 'error', error: `OpenAI error ${oaiRes.status}` });
        res.end();
        return;
      }

      const text = extractOpenAIText(data) || '(no response)';
      sendEvent({ type: 'done', text });
      res.end();
      return;
    }

    // ════════════════════════════════════════════════════════
    // ANTHROPIC PATH (Claude): streaming + web_search tool.
    // ════════════════════════════════════════════════════════
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: cfg.api,
        max_tokens: 4096,
        output_config: { effort: 'high' },
        stream: true,
        system: [
          { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }
        ],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 4,
        }],
        messages: cleanMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      sendEvent({ type: 'error', error: `Anthropic error ${anthropicRes.status}` });
      res.end();
      return;
    }

    // ── Parse the SSE stream from Anthropic ──
    let fullText = '';
    let currentSearchQuery = '';
    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();
        if (rawData === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(rawData); } catch { continue; }

        switch (evt.type) {
          case 'content_block_start':
            if (evt.content_block?.type === 'tool_use' && evt.content_block?.name === 'web_search') {
              sendEvent({ type: 'searching', message: '🔍 Searching the web…' });
            }
            break;

          case 'content_block_delta':
            if (evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
              sendEvent({ type: 'token', text: evt.delta.text });
            }
            if (evt.delta?.type === 'input_json_delta') {
              currentSearchQuery += evt.delta.partial_json || '';
            }
            break;

          case 'content_block_stop':
            currentSearchQuery = '';
            break;

          case 'message_stop':
            sendEvent({ type: 'done', text: fullText });
            break;

          case 'error':
            console.error('Anthropic stream error:', evt.error);
            sendEvent({ type: 'error', error: evt.error?.message || 'Stream error' });
            break;
        }
      }
    }

    if (fullText) {
      sendEvent({ type: 'done', text: fullText });
    }

  } catch (err) {
    console.error('chat-search handler error:', err);
    sendEvent({ type: 'error', error: err.message });
  }

  res.end();
}

// ── Pull the assistant text out of an OpenAI Responses API result ──
function extractOpenAIText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const out = Array.isArray(data.output) ? data.output : [];
  const texts = [];
  for (const item of out) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) texts.push(c.text);
      }
    }
  }
  return texts.join('\n');
}

function buildSystemPrompt() {
  return `You are Yash Hooda's AI assistant on his portfolio website. You have web_search to find current information.

IDENTITY: Data Engineer, UTD CS grad, IBM AI Engineering & Data Science certified, Databricks Certified. Runner — 5K PR 18:15, HM PR 1:24:31, training for 2026 Boulderthon Marathon. You can discuss his projects: HoodaAgents AI Hiring Engine, ClimatePulse pipeline, Virtual TA Chatbot, and more.
You know about his interests in aviation, astronomy, current world events, politics, economy, climate change, etc....

SEARCH RULES:
- Search for current events, news, weather, history, politics, economy, tech news, job market trends, natural disasters, recent AI/ML releases, race results, anything time-sensitive
- Cite sources naturally: "According to [outlet]..."
- Keep responses concise — 2-4 paragraphs max
- Do NOT search for things you already know
- DO NOT SEARCH for anything illegal or innappropriate

SAVE MARKERS: If user says "save this" or "bookmark this", include at end of reply:
[SAVE_ARTICLE: {"title": "...", "url": "...", "summary": "...", "tags": ["tag1","tag2"]}]

TONE: Sharp, direct, no fluff. Supportive on career/running goals.`;
}
