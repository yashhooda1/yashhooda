// api/chat-voice.js — low-latency streaming for the voice tab
export const maxDuration = 120;
export const config = { runtime: 'nodejs' };

const MODELS = {
  'claude-opus-4-8':   { provider: 'anthropic', api: 'claude-opus-4-8' },
  'claude-sonnet-4-6': { provider: 'anthropic', api: 'claude-sonnet-4-6' },
  'gpt-5.5':           { provider: 'openai',    api: 'gpt-5.5' },
  'gpt-5.4':           { provider: 'openai',    api: 'gpt-5.4' },
  'gpt-5.4-mini':      { provider: 'openai',    api: 'gpt-5.4-mini' },
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
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
    } else {
      await streamAnthropic(cfg.api, cleanMessages, send);
    }
  } catch (err) {
    console.error('chat-voice top-level error:', err);
    send({ type: 'error', error: err.message });
  }

  try { res.end(); } catch (e) {}
}

// ── ANTHROPIC ──
async function streamAnthropic(apiModel, messages, send) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { send({ type: 'error', error: 'ANTHROPIC_API_KEY not set' }); return; }

  // Build body — only add output_config for models that support it
  const supportsEffort = ['claude-opus-4-8', 'claude-sonnet-4-6'].includes(apiModel);
  const body = {
    model:      apiModel,
    max_tokens: 300,
    stream:     true,
    system: [{ type: 'text', text: VOICE_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (supportsEffort) body.output_config = { effort: 'low' };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error('Anthropic voice error:', r.status, t);
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
  // Fallback done in case message_stop was missed
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
    console.error('OpenAI voice error:', r.status, t);
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

      // Handle both possible delta event shapes from OpenAI Responses API
      const t =
        evt.delta                              ??  // response.output_text.delta
        evt.output_text_delta?.text            ??  // alternate shape
        evt.choices?.[0]?.delta?.content       ??  // chat-completions fallback
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

const VOICE_PROMPT = `You are Yash Hooda's AI voice assistant on his portfolio website.

WHO YASH IS: 24-year-old Data Engineer (UTD CS grad) moving into AI Engineering without a master's degree. Certified: Databricks Data Engineer, IBM AI Engineering, IBM Data Science, Vanderbilt Prompt Engineering, Microsoft Power Platform. Skills: PySpark, Databricks, Microsoft Fabric, SQL, LangChain, RAG, LLMs, Python. Runner — 5K PR 18:15, half marathon PR 1:24:31, training for the 2026 Boulderthon Marathon at 45 miles/week.

VOICE RULES — your text is read aloud, so:
- Replies must be 1-3 SHORT sentences maximum. This is a conversation.
- Plain spoken English only. No bullet points, no markdown, no asterisks, no emojis, no headers.
- Warm and direct — like a knowledgeable friend, not a chatbot.
- End with a natural follow-up only if it fits ("want me to go deeper on that?").
- If asked about Yash's projects, certifications, or contact: answer from what you know above.
- Never make up facts. If unsure, say so briefly.`;
