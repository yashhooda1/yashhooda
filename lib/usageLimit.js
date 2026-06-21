// lib/usageLimit.js
// ══════════════════════════════════════════════════════════════════════════════
// USAGE TRACKING — Free tier enforcement + Stripe premium check + Admin bypass
// Free:    50 messages/month per session
// Premium: unlimited (verified via Stripe)
// Admin:   unlimited forever (Yash's own session — set via ADMIN_SESSION_ID env var)
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FREE_LIMIT = 50; // free messages per month

// ── ADMIN CHECK — Yash's session ID stored in Vercel env var ─────────────────
// Set ADMIN_SESSION_ID in Vercel env vars to your localStorage session ID.
// To find yours: open yashhooda.ai → DevTools Console → type:
//   localStorage.getItem('hooda_session_id')
// Copy that value and set it as ADMIN_SESSION_ID in Vercel.
function isAdmin(sessionId) {
    const adminId = process.env.ADMIN_SESSION_ID;
    if (!adminId || !sessionId) return false;
    return sessionId === adminId;
}

// ── GET CURRENT MONTH KEY ────────────────────────────────────────────────────
function getMonthKey(sessionId) {
    const month = new Date().toISOString().slice(0, 7); // e.g. "2026-06"
    return `usage:${sessionId}:${month}`;
}

// ── CHECK IF SESSION HAS ACTIVE STRIPE SUBSCRIPTION ─────────────────────────
async function isPremium(sessionId) {
    try {
        const val = await redis.get(`premium:${sessionId}`);
        return val === 'active';
    } catch { return false; }
}

// ── MAIN USAGE CHECK ─────────────────────────────────────────────────────────
export async function checkUsageLimit(sessionId) {
    if (!sessionId) return { allowed: true, count: 0, limit: FREE_LIMIT, premium: false, admin: false };

    // ── ADMIN BYPASS — unlimited forever, no Redis check needed ──────────────
    if (isAdmin(sessionId)) {
        return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        // Premium users (paid Stripe) bypass all limits
        const premium = await isPremium(sessionId);
        if (premium) return { allowed: true, count: 0, limit: null, remaining: null, premium: true, admin: false };

        // Increment and check free tier
        const key   = getMonthKey(sessionId);
        const count = await redis.incr(key);

        // Set TTL on first use — expires after 35 days (covers full month)
        if (count === 1) await redis.expire(key, 60 * 60 * 24 * 35);

        const remaining = Math.max(0, FREE_LIMIT - count);
        const allowed   = count <= FREE_LIMIT;

        return { allowed, count, remaining, limit: FREE_LIMIT, premium: false, admin: false };

    } catch (err) {
        console.warn('[USAGE] Redis error (fail open):', err.message);
        return { allowed: true, count: 0, limit: FREE_LIMIT, premium: false, admin: false };
    }
}

// ── GET USAGE WITHOUT INCREMENTING (for UI display) ──────────────────────────
export async function getUsage(sessionId) {
    if (!sessionId) return { count: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT, premium: false, admin: false };

    if (isAdmin(sessionId)) {
        return { count: 0, limit: null, remaining: null, premium: true, admin: true };
    }

    try {
        const premium = await isPremium(sessionId);
        if (premium) return { count: 0, limit: null, remaining: null, premium: true, admin: false };

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

// ── ACTIVATE PREMIUM FOR SESSION (called by Stripe webhook) ──────────────────
export async function activatePremium(sessionId, months = 1) {
    const ttl = 60 * 60 * 24 * 30 * months;
    await redis.set(`premium:${sessionId}`, 'active', { ex: ttl });
}
