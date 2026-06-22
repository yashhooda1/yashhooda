// api/auth/me.js
// ══════════════════════════════════════════════════════════════════════════════
// ME — validates JWT, returns current user + usage stats
// Called on page load to restore session
// ══════════════════════════════════════════════════════════════════════════════

import { Redis }                         from '@upstash/redis';
import { getAuthUser, isAdminEmail }     from '../../lib/auth.js';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FREE_LIMIT = 20;

function getMonthKey(email) {
    const month = new Date().toISOString().slice(0, 7);
    return `usage:email:${email}:${month}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  'https://yashhooda.ai');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ error: 'Not authenticated.' });
    }

    try {
        // ── Get fresh user data from Redis ────────────────────────────────────
        const raw = await redis.get(`user:${user.email}`);
        if (!raw) return res.status(401).json({ error: 'User not found.' });

        const userData = typeof raw === 'string' ? JSON.parse(raw) : raw;

        // ── Check current premium status ──────────────────────────────────────
        const premiumRaw = await redis.get(`premium:email:${user.email}`);
        const isPremium  = premiumRaw === 'active' || isAdminEmail(user.email);
        const plan       = isAdminEmail(user.email) ? 'admin' : isPremium ? 'premium' : 'free';

        // ── Get usage count ───────────────────────────────────────────────────
        let usageCount = 0;
        if (!isPremium) {
            const key = getMonthKey(user.email);
            usageCount = parseInt(await redis.get(key) || '0', 10);
        }

        return res.status(200).json({
            ok:   true,
            user: {
                email:    user.email,
                name:     userData.name,
                verified: userData.verified,
                plan,
            },
            usage: {
                count:     usageCount,
                limit:     isPremium ? null : FREE_LIMIT,
                remaining: isPremium ? null : Math.max(0, FREE_LIMIT - usageCount),
                premium:   isPremium,
            },
        });

    } catch (err) {
        console.error('[ME] Error:', err);
        return res.status(500).json({ error: 'Failed to load user data.' });
    }
}
