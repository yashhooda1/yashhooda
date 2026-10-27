// lib/models.js — ES Module
// ══════════════════════════════════════════════════════════════════════════════
// SHARED MODEL CATALOG (added Oct 2026)
//
// One place that knows which chat models exist, which provider serves them,
// what to fall back to when an account lacks access, and which small model to
// use for cheap utility calls (CRAG grading, reranking, extraction).
//
// api/chat.js, api/chat-voice.js and api/chat-search.js still carry their own
// MODELS objects (kept for history and because each has provider-specific
// request shapes); they import the ADDITIONS below so new models land in all
// three at once. index.html's AI_MODELS list is the user-facing mirror.
//
// Verified against provider docs on 2026-10-27:
//   Anthropic: claude-fable-5-1 (current selected), claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5
//   OpenAI:    gpt-6.1-terra (Oct 26), gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-*, gpt-5.5, gpt-5.4(-mini/-nano)
//   Google:    gemini-4-argon (flagship), gemini-3.8-flash, gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview
//   xAI:       grok-4.7 (Sep 21), grok-4.6, grok-4.5, grok-4.3
// ══════════════════════════════════════════════════════════════════════════════

// New entries merged into every endpoint registry: { key: { provider, api } }.
export const MODEL_ADDITIONS = {
    // Anthropic — Claude 5.5 family + Fable
    'claude-opus-5-5':   { provider: 'anthropic', api: 'claude-opus-5-5' },
    'claude-sonnet-5-5': { provider: 'anthropic', api: 'claude-sonnet-5-5' },
    'claude-haiku-5-5':  { provider: 'anthropic', api: 'claude-haiku-5-5' },
    // OpenAI — GPT-6.x
    'gpt-6.1-sol':       { provider: 'openai',    api: 'gpt-6.1-sol' },
    'gpt-6.1-terra':     { provider: 'openai',    api: 'gpt-6.1-terra' },
    'gpt-6-sol':         { provider: 'openai',    api: 'gpt-6-sol' },
    'gpt-6-luna':        { provider: 'openai',    api: 'gpt-6-luna' },
    'gpt-5.4-nano':      { provider: 'openai',    api: 'gpt-5.4-nano' },
    // Google — Gemini 4 + current Flash tiers
    'gemini-4-argon':        { provider: 'google', api: 'gemini-4-argon' },
    'gemini-3.6-flash':      { provider: 'google', api: 'gemini-3.6-flash' },
    'gemini-3.5-flash-lite': { provider: 'google', api: 'gemini-3.5-flash-lite' },
    // xAI — Grok 4.6 / 4.7
    'grok-4.7':          { provider: 'xai',       api: 'grok-4.7' },
    'grok-4.6':          { provider: 'xai',       api: 'grok-4.6' },
};

// Full catalog = the long-standing entries + additions (handy for new endpoints).
export const MODELS = {
    'claude-opus-5':      { provider: 'anthropic', api: 'claude-opus-5' },
    'claude-sonnet-4-6':  { provider: 'anthropic', api: 'claude-sonnet-4-6' },
    'claude-sonnet-5':    { provider: 'anthropic', api: 'claude-sonnet-5' },
    'claude-fable-5':     { provider: 'anthropic', api: 'claude-fable-5' },
    'claude-fable-5-1':   { provider: 'anthropic', api: 'claude-fable-5-1' },
    'gpt-6-astra':        { provider: 'openai',    api: 'gpt-6-astra' },
    'gpt-5.6-sol':        { provider: 'openai',    api: 'gpt-5.6-sol' },
    'gpt-5.6-terra':      { provider: 'openai',    api: 'gpt-5.6-terra' },
    'gpt-5.6-luna':       { provider: 'openai',    api: 'gpt-5.6-luna' },
    'gpt-5.5':            { provider: 'openai',    api: 'gpt-5.5' },
    'gpt-5.4':            { provider: 'openai',    api: 'gpt-5.4' },
    'gpt-5.4-mini':       { provider: 'openai',    api: 'gpt-5.4-mini' },
    'grok-4.3':           { provider: 'xai',       api: 'grok-4.3' },
    'grok-4.5':           { provider: 'xai',       api: 'grok-4.5' },
    'gemini-3.8-flash':   { provider: 'google',    api: 'gemini-3.8-flash' },
    'gemini-3.5-flash':   { provider: 'google',    api: 'gemini-3.5-flash' },
    'gemini-3.1-pro-preview': { provider: 'google', api: 'gemini-3.1-pro-preview' },
    'llama-4-maverick':   { provider: 'together',  api: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-Turbo' },
    'llama-3.3-70b':      { provider: 'together',  api: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    ...MODEL_ADDITIONS,
};

export const DEFAULT_MODEL = process.env.DEFAULT_CHAT_MODEL || 'gpt-5.5';

// Cheap utility model for grading / reranking / extraction. Defaults to the
// proven Haiku 4.5 snapshot; set ANTHROPIC_FAST_MODEL=claude-haiku-5-5 in
// Vercel to upgrade without a code change. Calls made through
// anthropicWithFallback() drop to FAST_MODEL_FALLBACK automatically if the
// account cannot access the primary.
export const FAST_MODEL          = process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001';
export const FAST_MODEL_FALLBACK = 'claude-haiku-4-5-20251001';

// Which model to try when an account cannot access the requested one.
export const FALLBACKS = {
    // Anthropic
    'claude-opus-5-5':   'claude-opus-5',
    'claude-sonnet-5-5': 'claude-sonnet-5',
    'claude-haiku-5-5':  'claude-haiku-4-5-20251001',
    'claude-fable-5-1':  'claude-fable-5',
    'claude-fable-5':    'claude-opus-5',
    // OpenAI
    'gpt-6.1-sol':       'gpt-6-astra',
    'gpt-6.1-terra':     'gpt-5.6-terra',
    'gpt-6-sol':         'gpt-6-astra',
    'gpt-6-luna':        'gpt-5.6-luna',
    'gpt-6-astra':       'gpt-5.5',
    'gpt-5.6-sol':       'gpt-5.5',
    'gpt-5.6-terra':     'gpt-5.5',
    'gpt-5.6-luna':      'gpt-5.5',
    'gpt-5.4-nano':      'gpt-5.4-mini',
    // Google
    'gemini-4-argon':        'gemini-3.8-flash',
    'gemini-3.6-flash':      'gemini-3.5-flash',
    'gemini-3.5-flash-lite': 'gemini-3.5-flash',
    // xAI
    'grok-4.7':          'grok-4.5',
    'grok-4.6':          'grok-4.5',
};

// Claude 5-generation models think by default; their first content block is
// `thinking`, and thinking tokens count against max_tokens.
export const THINKS_BY_DEFAULT_RE = /^claude-(opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/;

// Provider error shapes that mean "this account cannot use this model".
export function isModelAccessError(status, data) {
    if (status === 404 || status === 403) return true;
    const e    = (data && data.error) || {};
    const code = String(e.code || e.type || '').toLowerCase();
    const msg  = String(e.message || '').toLowerCase();
    return code === 'model_not_found' || code === 'not_found_error'
        || (/model/.test(msg) && /(does not exist|not found|access|permission|not have|unavailable|unsupported)/.test(msg));
}

export function fallbackFor(apiModel) { return FALLBACKS[apiModel] || null; }

// POST /v1/messages with automatic one-step fallback on model-access errors.
// Returns { res, data, model } — `model` is the one that actually answered.
export async function anthropicWithFallback(apiKey, body, { fallback } = {}) {
    const call = async (model) => {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body:    JSON.stringify({ ...body, model }),
        });
        const data = await res.json().catch(() => ({}));
        return { res, data, model };
    };
    let out = await call(body.model);
    const alt = fallback || fallbackFor(body.model) || (body.model === FAST_MODEL ? FAST_MODEL_FALLBACK : null);
    if (!out.res.ok && alt && alt !== body.model && isModelAccessError(out.res.status, out.data)) {
        console.warn(`[models] ${body.model} not accessible — falling back to ${alt}`);
        out = await call(alt);
    }
    return out;
}
