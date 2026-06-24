// api/admin-killswitch.js
// ══════════════════════════════════════════════════════════════════════════════
// ADMIN KILL-SWITCH CONTROL
// Flip endpoint kill switches from the admin dashboard instead of the Upstash console.
//
// Auth: requires the correct ADMIN_PASSWORD in the body. Nothing else gets in.
//
// GET  (with ?adminPassword=... OR x-admin-password header) → current state
// POST { adminPassword, endpoint, on }                      → set a switch
//      endpoint: 'global' | 'code-agent' | 'code'
//      on:       true (disable for everyone but admin) | false (re-enable)
// ══════════════════════════════════════════════════════════════════════════════

import { setKillSwitch, getKillSwitchState } from '../lib/killSwitch.js';

const VALID_ENDPOINTS = new Set(['global', 'code-agent', 'code']);

function getAdminPassword(req) {
    return (
        req.headers['x-admin-password'] ||
        req.body?.adminPassword ||
        req.query?.adminPassword ||
        ''
    );
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
    if (req.method === 'OPTIONS') return res.status(204).end();

    // ── AUTH — admin only ─────────────────────────────────────────────────────
    const provided = getAdminPassword(req);
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
        return res.status(500).json({ error: 'ADMIN_PASSWORD not configured.' });
    }
    if (!provided || provided !== expected) {
        // Generic 403 — don't reveal whether the endpoint exists or why it failed.
        console.warn(`[KILL-SWITCH] unauthorized attempt ip=${req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'}`);
        return res.status(403).json({ error: 'forbidden' });
    }

    // ── GET — return current state ────────────────────────────────────────────
    if (req.method === 'GET') {
        const state = await getKillSwitchState();
        if (state === null) return res.status(502).json({ error: 'Could not read kill-switch state.' });
        return res.status(200).json({ state });
    }

    // ── POST — set a switch ───────────────────────────────────────────────────
    if (req.method === 'POST') {
        const { endpoint, on } = req.body || {};
        if (!VALID_ENDPOINTS.has(endpoint)) {
            return res.status(400).json({ error: `Invalid endpoint. Must be one of: ${[...VALID_ENDPOINTS].join(', ')}` });
        }
        if (typeof on !== 'boolean') {
            return res.status(400).json({ error: '`on` must be a boolean (true = disable, false = enable).' });
        }

        try {
            const result = await setKillSwitch(endpoint, on);
            const state  = await getKillSwitchState();
            console.warn(`[KILL-SWITCH] admin set ${endpoint}=${on ? 'ON' : 'OFF'}`);
            return res.status(200).json({ ok: true, changed: result, state });
        } catch (e) {
            console.error('[KILL-SWITCH] set failed:', e.message);
            return res.status(502).json({ error: 'Failed to update kill switch.' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
