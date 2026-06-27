// api/prompt-lab.js
// ══════════════════════════════════════════════════════════════════════════════
// PROMPT LAB — Compare prompting strategies side by side
// Gap 1: Prompt & Context Engineering
// ══════════════════════════════════════════════════════════════════════════════

import { PROMPT_STRATEGIES } from '../lib/promptTemplates.js';
import { checkKillSwitch }   from '../lib/killSwitch.js';

export const maxDuration = 60;

const ALLOWED_ORIGINS = new Set([
  'https://yashhooda.ai',
  'https://www.yashhooda.ai',
  'https://yashhooda1.vercel.app',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

const isAdmin = adminPassword && adminPassword === process.env.ADMIN_PASSWORD;
const ks = await checkKillSwitch('prompt-lab', isAdmin);
if (!ks.ok) return res.status(ks.status).json(ks.body);

  const {
    query,
    strategy   = 'zero-shot',
    domain     = 'general',
    role       = 'marathon coach',
    context    = '',
    compareAll = false,
    adminPassword,
  } = req.body || {};

  if (!query || typeof query !== 'string' || query.length < 2 || query.length > 2000) {
    return res.status(400).json({ error: 'query must be 2–2000 characters' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

  // ── Build the strategies to run ─────────────────────────────────────────
  const strategiesToRun = compareAll
    ? ['zero-shot', 'few-shot', 'cot', 'xml-structured']
    : [strategy];

  const results = [];

  for (const stratKey of strategiesToRun) {
    const strat = PROMPT_STRATEGIES[stratKey];
    if (!strat) { results.push({ strategy: stratKey, error: 'Unknown strategy' }); continue; }

    const built = strat.build(query, context, domain || role);
    const start = Date.now();

    try {
      // Build Anthropic messages
      const systemContent = built.cacheControl
        ? [{ type: 'text', text: built.system, cache_control: { type: 'ephemeral' } }]
        : built.system;

      const requestBody = {
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     systemContent,
        messages:   [{ role: 'user', content: built.user }],
      };

      // Extended thinking support
      if (built.thinking) {
        requestBody.thinking   = built.thinking;
        requestBody.max_tokens = 12000; // must be > budget_tokens
      }

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
      });

      const data    = await anthropicRes.json();
      const elapsed = Date.now() - start;

      if (!anthropicRes.ok) {
        results.push({ strategy: stratKey, error: data?.error?.message || 'API error', elapsed });
        continue;
      }

      // Extract text (skip thinking blocks)
      const textBlocks    = (data.content || []).filter(b => b.type === 'text');
      const thinkingBlocks = (data.content || []).filter(b => b.type === 'thinking');
      const reply          = textBlocks.map(b => b.text).join('\n').trim();
      const thinking       = thinkingBlocks.map(b => b.thinking).join('\n').trim();

      results.push({
        strategy:    stratKey,
        label:       strat.label,
        emoji:       strat.emoji,
        color:       strat.color,
        description: strat.description,
        reply,
        thinking:    thinking || null,
        promptUsed:  { system: built.system.slice(0, 300) + '…', user: built.user },
        tokens: {
          input:  data.usage?.input_tokens  || 0,
          output: data.usage?.output_tokens || 0,
          cache:  data.usage?.cache_read_input_tokens || 0,
        },
        elapsed,
      });

    } catch (err) {
      results.push({ strategy: stratKey, error: err.message, elapsed: Date.now() - start });
    }
  }

  return res.status(200).json({
    query,
    strategy,
    compareAll,
    results,
    timestamp: new Date().toISOString(),
  });
}
