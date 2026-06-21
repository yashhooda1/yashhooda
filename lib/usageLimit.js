// lib/usageLimit.js
// ══════════════════════════════════════════════════════════════════════════════
// USAGE TRACKING — Free tier + Stripe premium + Admin bypass
// Free:    50 messages/month per session
// Premium: unlimited (verified via Stripe email)
// Admin:   yash.hooda6@gmail.com + ADMIN_SESSION_ID — unlimited forever, no checks
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FREE_LIMIT = 50;

// ── ADMIN — hardcoded email + env var session ID ──────────────────────────────
const ADMIN_EMAIL = 'yash.hooda6@gmail.com';

function isAdmin(sessionId, email) {
    // Admin by email
    if (email && email.toLowerCase().trim() === ADMIN_EMAIL) return true;
    // Admin by session ID (set ADMIN_SESSION_ID in Vercel env vars)
    const adminSession = process.env.ADMIN_SESSION_ID;
    if (adminSession && sessionId && sessionId === adminSession) return true;
    return false;
}

// ── MONTH KEY ─────────────────────────────────────────────────────────────────
function getMonthKey(sessionId) {
    const month = new Date().toISOString().slice(0, 7);
    return `usage:${sessionId}:${month}`;
}

// ── PREMIUM CHECKS ────────────────────────────────────────────────────────────
async function isPremiumBySession(sessionId) {
    try {
        const val = await redis.get(`premium:${sessionId}`);
        return val === 'active';
    } catch { return false; }
}

export async function isPremiumByEmail(email) {
    if (!email) return false;
    try {
        const val = await redis.get(`premium:email:${email.toLowerCase().trim()}`);
        return val === 'active';
    } catch { return false; }
}

// ── MAIN USAGE CHECK ──────────────────────────────────────────────────────────
export async function checkUsageLimit(sessionId, email = null) {
    if (!sessionId) return { allowed: true, count: 0, limit: FREE_LIMIT, premium: false, admin: false };

    // ── ADMIN BYPASS — no Redis, no limits, ever ──────────────────────────────
    if (isAdmin(sessionId, email)) {
        return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        // Premium by session (current device already claimed)
        const premiumSession = await isPremiumBySession(sessionId);
        if (premiumSession) return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: false };

        // Premium by email (paid on another device)
        if (email) {
            const premiumEmail = await isPremiumByEmail(email);
            if (premiumEmail) {
                // Auto-link this session so they don't need to re-enter email
                await activatePremium(sessionId, 1);
                return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: false };
            }
        }

        // Free tier — increment and check
        const key   = getMonthKey(sessionId);
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
export async function getUsage(sessionId, email = null) {
    if (!sessionId) return { count: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT, premium: false, admin: false };

    if (isAdmin(sessionId, email)) {
        return { count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        const premiumSession = await isPremiumBySession(sessionId);
        if (premiumSession) return { count: 0, limit: null, remaining: null, premium: true, admin: false };

        if (email) {
            const premiumEmail = await isPremiumByEmail(email);
            if (premiumEmail) return { count: 0, limit: null, remaining: null, premium: true, admin: false };
        }

        const key   = getMonthKey(sessionId);
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

// ── ACTIVATE PREMIUM BY SESSION (Stripe webhook — current device) ─────────────
export async function activatePremium(sessionId, months = 1) {
    const ttl = 60 * 60 * 24 * 30 * months;
    await redis.set(`premium:${sessionId}`, 'active', { ex: ttl });
}

// ── ACTIVATE PREMIUM BY EMAIL (Stripe webhook — cross-device) ────────────────
export async function activatePremiumByEmail(email, months = 1) {
    const ttl = 60 * 60 * 24 * 30 * months;
    await redis.set(`premium:email:${email.toLowerCase().trim()}`, 'active', { ex: ttl });
}
