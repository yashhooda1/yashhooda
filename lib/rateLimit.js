import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Admin IPs or session tokens that bypass rate limiting
const ADMIN_SESSIONS = new Set([
    process.env.ADMIN_SESSION_TOKEN, // set this in Vercel env vars
]);

const ADMIN_IPS = new Set([
    process.env.ADMIN_IP, // your home/work IP
]);

export async function rateLimit(req, res, options = {}) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    
    // ── ADMIN BYPASS ──
    if (ADMIN_IPS.has(ip)) return true;
    
    const sessionId = req.body?.sessionId || req.headers['x-session-id'];
    if (sessionId && ADMIN_SESSIONS.has(sessionId)) return true;

    const {
        maxPerMinute = 5,
        maxPerHour = 20,
        maxDailyGlobal = 200,
        endpoint = 'api',
    } = options;

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const hourKey = now.toISOString().slice(0, 13);
    const minuteKey = now.toISOString().slice(0, 16);

    const keys = {
        minute:  `rl:${endpoint}:ip:${ip}:min:${minuteKey}`,
        hour:    `rl:${endpoint}:ip:${ip}:hr:${hourKey}`,
        daily:   `rl:${endpoint}:global:${dateKey}`,
    };

    // Run all checks in parallel
    const [minCount, hrCount, dayCount] = await Promise.all([
        redis.incr(keys.minute),
        redis.incr(keys.hour),
        redis.incr(keys.daily),
    ]);

    // Set TTLs on first hit
    if (minCount === 1) await redis.expire(keys.minute, 60);
    if (hrCount === 1)  await redis.expire(keys.hour, 3600);
    if (dayCount === 1) await redis.expire(keys.daily, 86400);

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

    return true; // allowed
}
