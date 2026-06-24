// lib/killSwitch.js
// ══════════════════════════════════════════════════════════════════════════════
// ADMIN-BYPASSABLE KILL SWITCH
// One place to disable expensive endpoints (code-agent, code) WITHOUT a redeploy.
//
// Two layers, checked in order:
//   1. Redis flag  — flip live from Upstash console, no deploy needed (preferred)
//   2. Env var     — set in Vercel dashboard (triggers a redeploy)
//
// Admin (correct ADMIN_PASSWORD) ALWAYS bypasses, even when the switch is on.
//
// USAGE in an endpoint:
//   import { checkKillSwitch } from '../lib/killSwitch.js';
//   const isAdminReq = adminPassword && adminPassword === process.env.ADMIN_PASSWORD;
//   const ks = await checkKillSwitch('code-agent', isAdminReq);
//   if (!ks.ok) return res.status(ks.status).json(ks.body);
//
// TO DISABLE an endpoint live (no deploy):
//   Upstash console →  SET killswitch:code-agent on
//   Re-enable       →  DEL killswitch:code-agent   (or SET ... off)
//
// TO DISABLE everything at once:
//   SET killswitch:global on
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Map endpoint name → the env var that also disables it (redeploy-based fallback).
const ENV_FLAGS = {
    'code-agent': 'CODE_AGENT_OFF',
    'code':       'CODE_OFF',
};

function envSaysOff(endpoint) {
    const v = process.env.ENDPOINT_KILL_ALL || process.env[ENV_FLAGS[endpoint]] || '';
    return String(v).toLowerCase() === 'on' || String(v).toLowerCase() === 'true' || v === '1';
}

function isOnValue(v) {
    if (v === null || v === undefined) return false;
    const s = String(v).toLowerCase();
    return s === 'on' || s === 'true' || s === '1' || s === 'banned';
}

// ── MAIN CHECK ────────────────────────────────────────────────────────────────
// Returns { ok: true } to proceed, or { ok: false, status, body } to short-circuit.
export async function checkKillSwitch(endpoint, isAdmin = false) {
    // Admin always passes — they can keep using the endpoint while it's killed for everyone else.
    if (isAdmin) return { ok: true };

    // 1. Redis live flags (no redeploy needed).
    try {
        const [globalFlag, endpointFlag] = await Promise.all([
            redis.get('killswitch:global'),
            redis.get(`killswitch:${endpoint}`),
        ]);
        if (isOnValue(globalFlag) || isOnValue(endpointFlag)) {
            return {
                ok: false,
                status: 503,
                body: {
                    error:   'service_unavailable',
                    message: 'This feature is temporarily disabled for maintenance. Please check back soon.',
                },
            };
        }
    } catch (e) {
        // If Redis is unreachable, fall through to env check — don't fail open silently.
        console.error('[KILL-SWITCH] redis check failed:', e.message);
    }

    // 2. Env var fallback (redeploy-based).
    if (envSaysOff(endpoint)) {
        return {
            ok: false,
            status: 503,
            body: {
                error:   'service_unavailable',
                message: 'This feature is temporarily disabled. Please check back soon.',
            },
        };
    }

    return { ok: true };
}

// ── Optional helpers to flip the switch from an admin endpoint ────────────────
export async function setKillSwitch(endpoint, on) {
    const key = endpoint === 'global' ? 'killswitch:global' : `killswitch:${endpoint}`;
    if (on) await redis.set(key, 'on');
    else    await redis.del(key);
    return { endpoint, on: !!on };
}

export async function getKillSwitchState() {
    try {
        const keys = ['killswitch:global', 'killswitch:code-agent', 'killswitch:code'];
        const vals = await Promise.all(keys.map(k => redis.get(k)));
        return {
            global:        isOnValue(vals[0]),
            'code-agent':  isOnValue(vals[1]),
            'code':        isOnValue(vals[2]),
        };
    } catch {
        return null;
    }
}
