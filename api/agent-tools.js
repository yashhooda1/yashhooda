// api/agent-tools.js
// Tool-calling agent loop over the MCP-shaped registry (lib/tools/registry.js).
//   GET  /api/agent-tools            → { tools: [...] }   (tools/list)
//   POST /api/agent-tools            → { reply, steps: [{ tool, args, result }], model }
//        body: { message, history?: [{role, content}], confirm?: boolean }
// Read tools: any logged-in user. Write tools: admin only, and only with confirm:true.
// Kill switch key: killswitch:agent-tools

import { gate }         from '../lib/gateway.js';
import { rateLimit }    from '../lib/rateLimit.js';
import { notifyFailure } from './_notify.js';
import { listTools, callTool } from '../lib/tools/registry.js';

export const maxDuration = 60;

const MODEL     = process.env.AGENT_TOOLS_MODEL || 'claude-sonnet-4-6';
const MAX_STEPS = 6;

const SYSTEM = `You are the running & training agent on yashhooda.ai, speaking about Yash Hooda (competitive marathoner, sub-3:00 goal, training for the 2027 Chevron Houston Marathon).
Rules:
- Never estimate training numbers yourself. Call tools for mileage, load, paces, and predictions, then explain the structured output.
- Every recommendation must reference the named threshold or number that drove it (e.g. "form -24 is below the -20 fatigued line").
- If a tool errors or is unavailable, say so plainly and answer with what you do have.
- Be concise: a short answer, then at most 3 bullet points.`;

export default async function handler(req, res) {
  const g = await gate(req, res, { endpoint: 'agent-tools', methods: ['GET', 'POST'], auth: 'user' });
  if (!g.ok) return;

  if (req.method === 'GET') {
    const tools = await listTools({ includeWrite: g.isAdmin });
    return res.status(200).json({ tools: tools.map(({ name, description, write, source }) => ({ name, description, write, source })) });
  }

  const allowed = await rateLimit(req, res, { endpoint: 'agent-tools', maxPerMinute: 6, maxPerHour: 30, maxDailyGlobal: 300 });
  if (!allowed) return;

  const { message, history = [], confirm = false } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 2000) {
    return res.status(400).json({ error: 'message required (≤2000 chars)' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'agent_unavailable' });

  try {
    const tools = await listTools({ includeWrite: g.isAdmin && confirm === true });
    const anthropicTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

    const messages = [
      ...history.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'),
      { role: 'user', content: message },
    ];
    const steps = [];

    for (let i = 0; i < MAX_STEPS; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, tools: anthropicTools, messages }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `anthropic_${r.status}`);

      const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
      if (data.stop_reason !== 'tool_use' || !toolUses.length) {
        const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return res.status(200).json({ reply, steps, model: MODEL });
      }

      messages.push({ role: 'assistant', content: data.content });
      const results = [];
      for (const tu of toolUses) {
        const out = await callTool(tu.name, tu.input);
        const text = out.content?.map(c => c.text || '').join('\n') || '';
        steps.push({ tool: tu.name, args: tu.input, result: text.slice(0, 4000), isError: !!out.isError });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: text.slice(0, 12000), is_error: !!out.isError });
      }
      messages.push({ role: 'user', content: results });
    }

    return res.status(200).json({ reply: 'I hit the tool-call limit before finishing — try a narrower question.', steps, model: MODEL });
  } catch (err) {
    console.error('[AGENT-TOOLS]', err.message);
    try { await notifyFailure({ route: 'agent-tools', model: MODEL, error: err, userMessage: message }); } catch {}
    return res.status(500).json({ error: 'agent_failed', message: err.message });
  }
}
