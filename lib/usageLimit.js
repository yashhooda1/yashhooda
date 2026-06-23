// lib/usageLimit.js
// ══════════════════════════════════════════════════════════════════════════════
// USAGE TRACKING — tied to authenticated email (not session ID)
// Free:    20 messages/month
// Premium: unlimited (verified via Stripe)
// Admin:   yash.hooda6@gmail.com — unlimited forever
// Banned:  Redis set 'banned:emails' — instant ban/unban, no redeploy
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }         from '@upstash/redis';
import { isAdminEmail }  from './auth.js';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FREE_LIMIT = 20;

function normalizeEmail(email) {
    return email.toLowerCase().trim();
}

function getMonthKey(email) {
    const month = new Date().toISOString().slice(0, 7);
    return `usage:email:${normalizeEmail(email)}:${month}`;
}

async function isBanned(email) {
    try {
        const banned = await redis.sismember('banned:emails', normalizeEmail(email));
        return banned === 1;
    } catch { return false; }
}

async function isPremium(email) {
    try {
        const val = await redis.get(`premium:email:${normalizeEmail(email)}`);
        return val === 'active';
    } catch { return false; }
}

// ── MAIN USAGE CHECK — pass authenticated user email ─────────────────────────
export async function checkUsageLimit(email) {
    if (!email) {
        // Not logged in — block completely
        return { allowed: false, reason: 'login_required', count: 0, limit: FREE_LIMIT, premium: false, admin: false };
    }

    // ── Banned check — runs FIRST, before admin/premium ───────────────────────
    if (await isBanned(email)) {
        return { allowed: false, reason: 'banned', count: 0, limit: 0, premium: false, admin: false };
    }

    // ── Admin — unlimited forever ─────────────────────────────────────────────
    if (isAdminEmail(email)) {
        return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        // ── Premium check ─────────────────────────────────────────────────────
        const premium = await isPremium(email);
        if (premium) {
            return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: false };
        }

        // ── Free tier ─────────────────────────────────────────────────────────
        const key   = getMonthKey(email);
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, 60 * 60 * 24 * 35);

        const remaining = Math.max(0, FREE_LIMIT - count);
        const allowed   = count <= FREE_LIMIT;

        return { allowed, count, remaining, limit: FREE_LIMIT, premium: false, admin: false };

    } catch (err) {
        console.warn('[USAGE] Redis error (fail open):', err.message);
        return { allowed: true, count: 0, limit: FREE_LIMIT, premium: false, admin: false };
    }
}

// ── GET USAGE WITHOUT INCREMENTING ───────────────────────────────────────────
export async function getUsage(email) {
    if (!email) return { count: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT, premium: false, admin: false };

    if (await isBanned(email)) {
        return { count: 0, limit: 0, remaining: 0, premium: false, admin: false, banned: true };
    }

    if (isAdminEmail(email)) {
        return { count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        const premium = await isPremium(email);
        if (premium) return { count: 0, limit: null, remaining: null, premium: true, admin: false };

        const key   = getMonthKey(email);
        const count = parseInt(await redis.get(key) || '0', 10);
        return {
            count,
            limit:     FREE_LIMIT,
            remaining: Math.max(0, FREE_LIMIT - count),
            premium:   false,
            admin:     false,
        };
    } catch { return { count: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT, premium: false, admin: false }; }
}

// ── BAN / UNBAN HELPERS (optional — can also do directly in Upstash console) ──
export async function banEmail(email) {
    await redis.sadd('banned:emails', normalizeEmail(email));
}

export async function unbanEmail(email) {
    await redis.srem('banned:emails', normalizeEmail(email));
}

// ── ACTIVATE PREMIUM BY EMAIL ─────────────────────────────────────────────────
export async function activatePremiumByEmail(email, months = 1) {
    const ttl = 60 * 60 * 24 * 30 * months;
    await redis.set(`premium:email:${normalizeEmail(email)}`, 'active', { ex: ttl });
}

export async function isPremiumByEmail(email) {
    if (!email) return false;
    try {
        const val = await redis.get(`premium:email:${normalizeEmail(email)}`);
        return val === 'active';
    } catch { return false; }
}
