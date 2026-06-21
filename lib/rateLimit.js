// lib/rateLimit.js
// ══════════════════════════════════════════════════════════════════════════════
// RATE LIMITER — per-IP minute/hour + global daily cap + auto-ban
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function rateLimit(req, res, options = {}) {
    const {
        maxPerMinute   = 5,
        maxPerHour     = 20,
        maxDailyGlobal = 200,
        endpoint       = 'api',
    } = options;

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

    // ── STEP 1: Check existing ban ─────────────────────────────────────────
    try {
        const banned = await redis.get(`banned:${ip}`);
        if (banned) {
            res.status(403).json({ error: 'Forbidden.' });
            return false;
        }
    } catch { /* Redis down — fail open, don't block legit users */ }

    const now       = new Date();
    const dateKey   = now.toISOString().slice(0, 10);
    const hourKey   = now.toISOString().slice(0, 13);
    const minuteKey = now.toISOString().slice(0, 16);

    const keys = {
        minute:   `rl:${endpoint}:ip:${ip}:min:${minuteKey}`,
        hour:     `rl:${endpoint}:ip:${ip}:hr:${hourKey}`,
        daily:    `rl:${endpoint}:global:${dateKey}`,
        velocity: `vel:${endpoint}:${ip}`,
    };

    try {
        // ── STEP 2: Run all counters in parallel ───────────────────────────
        const [minCount, hrCount, dayCount, velCount] = await Promise.all([
            redis.incr(keys.minute),
            redis.incr(keys.hour),
            redis.incr(keys.daily),
            redis.incr(keys.velocity),
        ]);

        // Set TTLs on first hit
        if (minCount === 1) await redis.expire(keys.minute,   60);
        if (hrCount  === 1) await redis.expire(keys.hour,     3600);
        if (dayCount === 1) await redis.expire(keys.daily,    86400);
        if (velCount === 1) await redis.expire(keys.velocity, 300);   // 5-min window

        // ── STEP 3: Auto-ban on velocity abuse (>30 req in 5 min) ─────────
        if (velCount > 30) {
            // Escalating bans: 1h → 24h → 7d → 30d
            const banKey  = `ban_count:${ip}`;
            const banHits = await redis.incr(banKey);
            if (banHits === 1) await redis.expire(banKey, 60 * 60 * 24 * 30);

            const banTtl =
                banHits >= 4 ? 60 * 60 * 24 * 30   // 30 days
              : banHits === 3 ? 60 * 60 * 24 * 7    // 7 days
              : banHits === 2 ? 60 * 60 * 24         // 24 hours
              :                 60 * 60;              // 1 hour

            await redis.set(`banned:${ip}`, banHits.toString(), { ex: banTtl });
            console.warn(`[RATE-LIMIT] Auto-banned ${ip} (offense #${banHits}, TTL ${banTtl}s)`);
            res.status(403).json({ error: 'Forbidden.' });
            return false;
        }

        // ── STEP 4: Standard rate checks ──────────────────────────────────
        if (minCount > maxPerMinute) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'Too many requests. Slow down.' });
            return false;
        }
        if (hrCount > maxPerHour) {
            res.setHeader('Retry-After', '3600');
            res.status(429).json({ error: 'Hourly limit reached.' });
            return false;
        }
        if (dayCount > maxDailyGlobal) {
            res.setHeader('Retry-After', '86400');
            res.status(429).json({ error: 'Daily global limit reached.' });
            return false;
        }

    } catch (err) {
        console.warn('[RATE-LIMIT] Redis error (fail open):', err.message);
        // Fail open — don't block legitimate users if Redis is down
    }

    return true;
}
