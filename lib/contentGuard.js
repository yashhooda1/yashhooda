// lib/contentGuard.js
// ══════════════════════════════════════════════════════════════════════════════
// SHARED CONTENT-SAFETY + ABUSE AUTO-BAN
// Used by chat-voice.js, analyze.js, code-agent.js (and anywhere else).
//
// What it does:
//   • Screens user input against disallowed-content categories
//     (sexual/explicit, CSAM, piracy, malware/intrusion, violence/weapons,
//      illicit drugs, self-harm facilitation, hate)
//   • Tracks strikes per identity (email if logged in, else IP) in Redis
//   • Escalates: warn → temp ban → long ban, automatically
//
// Design notes:
//   • Blocking is keyword/heuristic based. It is intentionally conservative and
//     errs toward refusing borderline requests on these expensive endpoints.
//   • CSAM (child sexual content) is treated with zero tolerance — immediate
//     long ban, and we never describe or echo the matched terms back.
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── CATEGORY PATTERNS ─────────────────────────────────────────────────────────
// Kept deliberately high-signal to limit false positives on legit dev/running/
// career questions. Each entry: { category, severity, patterns[] }.
// severity: 'zero_tolerance' | 'high' | 'standard'

const RULES = [
    {
        category: 'csam',
        severity: 'zero_tolerance',
        patterns: [
            /\b(child|children|minor|underage|preteen|pre-teen|kid|toddler|infant)\b[^.]{0,40}\b(sex|nude|naked|porn|explicit|fondl|molest)/i,
            /\b(loli|shota|cp|jailbait)\b/i,
            /\b(sex|nude|naked|porn|explicit)\b[^.]{0,40}\b(child|children|minor|underage|preteen|kid|toddler)/i,
        ],
    },
    {
        category: 'sexual_explicit',
        severity: 'high',
        patterns: [
            /\b(porn|pornographic|xxx|hardcore|nsfw)\b/i,
            /\bgenerate\b[^.]{0,40}\b(nude|naked|sexual|erotic|explicit)\b/i,
            /\b(erotica|smut|sexting)\b/i,
            /\b(blowjob|handjob|cumshot|creampie|gangbang|deepthroat)\b/i,
            /\b(masturbat|orgasm|ejaculat)\w*/i,
            /\bsexual\b[^.]{0,30}\b(roleplay|story|fantasy|content|image|scene)\b/i,
            /\b(rape|noncon|non-consensual)\b[^.]{0,30}\b(story|scene|fantasy|roleplay)\b/i,
        ],
    },
    {
        category: 'piracy',
        severity: 'standard',
        patterns: [
            /\b(crack|keygen|serial key|license key)\b[^.]{0,30}\b(software|game|adobe|windows|office|app)\b/i,
            /\b(pirate|piracy|torrent)\b[^.]{0,30}\b(movie|film|game|software|album|book|show)\b/i,
            /\bbypass\b[^.]{0,20}\b(drm|paywall|license|activation|copyright)\b/i,
            /\b(free|download)\b[^.]{0,20}\b(premium|paid|cracked|nulled)\b[^.]{0,20}\b(version|account|software)\b/i,
            /\bhow to (pirate|illegally download|stream pirated)\b/i,
        ],
    },
    {
        category: 'malware_intrusion',
        severity: 'high',
        patterns: [
            /\b(ransomware|keylogger|rootkit|botnet|trojan|spyware|worm|stealer)\b/i,
            /\b(reverse shell|privilege escalation|exfiltrat)\w*/i,
            /\bcredential (stealer|harvest|dump|stuff)/i,
            /\bbypass\b[^.]{0,20}\b(auth|authentication|2fa|mfa|login)\b/i,
            /\b(ddos|denial of service)\b[^.]{0,20}\b(attack|tool|script)\b/i,
            /\bhack(ing)?\b[^.]{0,25}\b(into|someone|account|server|wifi|network|system|phone)\b/i,
            /\b(phishing|spoof)\b[^.]{0,20}\b(kit|page|site|email|template)\b/i,
        ],
    },
    {
        category: 'weapons_violence',
        severity: 'high',
        patterns: [
            /\bhow to (make|build|create)\b[^.]{0,25}\b(bomb|explosive|ied|grenade|napalm|nerve agent|bioweapon)\b/i,
            /\b(3d ?print|manufacture|untraceable)\b[^.]{0,20}\b(gun|firearm|ghost gun)\b/i,
            /\bsynthesize\b[^.]{0,20}\b(ricin|sarin|vx|anthrax)\b/i,
        ],
    },
    {
        category: 'illicit_drugs',
        severity: 'standard',
        patterns: [
            /\bhow to (make|synthesize|cook|manufacture)\b[^.]{0,20}\b(meth|methamphetamine|fentanyl|heroin|cocaine|mdma|lsd)\b/i,
            /\b(recipe|synthesis|cook)\b[^.]{0,15}\b(meth|fentanyl|heroin)\b/i,
        ],
    },
    {
        category: 'hate',
        severity: 'high',
        patterns: [
            /\bgenerate\b[^.]{0,30}\b(racist|nazi|hateful|genocid)\w*/i,
            /\b(ethnic cleansing|white genocide|gas the)\b/i,
        ],
    },
];

// ── STRIKE / BAN POLICY ───────────────────────────────────────────────────────
const STRIKE_TTL_SECONDS      = 60 * 60 * 24 * 7; // strikes decay over 7 days
const TEMP_BAN_SECONDS        = 60 * 60;          // 1h temp ban
const LONG_BAN_SECONDS        = 60 * 60 * 24 * 30;// 30d ban
const STRIKES_FOR_TEMP_BAN    = 2;
const STRIKES_FOR_LONG_BAN    = 4;

function identityKey(identity) {
    return `strikes:${identity.type}:${identity.value}`;
}

// ── SCREEN TEXT — returns { blocked, category, severity } ─────────────────────
export function screenContent(text) {
    if (!text || typeof text !== 'string') return { blocked: false };
    for (const rule of RULES) {
        for (const pat of rule.patterns) {
            if (pat.test(text)) {
                return { blocked: true, category: rule.category, severity: rule.severity };
            }
        }
    }
    return { blocked: false };
}

// ── RESOLVE IDENTITY (prefer email, else IP) ──────────────────────────────────
export function resolveIdentity(req, authUser) {
    if (authUser?.email) {
        return { type: 'email', value: String(authUser.email).toLowerCase().trim() };
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    return { type: 'ip', value: ip };
}

// ── CHECK IF ALREADY BANNED (email + ip) ──────────────────────────────────────
export async function isBanned(req, authUser) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    try {
        const checks = [redis.sismember('banned:ips', ip)];
        if (authUser?.email) {
            checks.push(redis.sismember('banned:emails', String(authUser.email).toLowerCase().trim()));
        }
        // temp bans live under a TTL key
        checks.push(redis.get(`tempban:ip:${ip}`));
        if (authUser?.email) checks.push(redis.get(`tempban:email:${String(authUser.email).toLowerCase().trim()}`));

        const results = await Promise.all(checks);
        return results.some(r => r === 1 || r === 'banned');
    } catch {
        return false; // fail open on redis hiccup
    }
}

// ── RECORD A STRIKE + AUTO-ESCALATE ───────────────────────────────────────────
// Returns { action: 'warn'|'temp_ban'|'long_ban', strikes }
export async function recordStrike(identity, severity) {
    try {
        // Zero-tolerance categories ban immediately and permanently-ish.
        if (severity === 'zero_tolerance') {
            await applyLongBan(identity);
            return { action: 'long_ban', strikes: STRIKES_FOR_LONG_BAN };
        }

        const key   = identityKey(identity);
        const weight = severity === 'high' ? 2 : 1;
        const strikes = await redis.incrby(key, weight);
        if (strikes === weight) await redis.expire(key, STRIKE_TTL_SECONDS);

        if (strikes >= STRIKES_FOR_LONG_BAN) {
            await applyLongBan(identity);
            return { action: 'long_ban', strikes };
        }
        if (strikes >= STRIKES_FOR_TEMP_BAN) {
            await applyTempBan(identity);
            return { action: 'temp_ban', strikes };
        }
        return { action: 'warn', strikes };
    } catch {
        return { action: 'warn', strikes: 0 };
    }
}

async function applyTempBan(identity) {
    if (identity.type === 'email') {
        await redis.set(`tempban:email:${identity.value}`, 'banned', { ex: TEMP_BAN_SECONDS });
    } else {
        await redis.set(`tempban:ip:${identity.value}`, 'banned', { ex: TEMP_BAN_SECONDS });
    }
}

async function applyLongBan(identity) {
    // Permanent set membership + a TTL marker for clarity
    if (identity.type === 'email') {
        await redis.sadd('banned:emails', identity.value);
        await redis.set(`tempban:email:${identity.value}`, 'banned', { ex: LONG_BAN_SECONDS });
    } else {
        await redis.sadd('banned:ips', identity.value);
        await redis.set(`tempban:ip:${identity.value}`, 'banned', { ex: LONG_BAN_SECONDS });
    }
}

// ── ONE-CALL GATE — screen + strike + decide ──────────────────────────────────
// Returns { ok: true } to proceed, or { ok: false, status, body } to return.
export async function guardRequest(req, authUser, text, { isAdmin = false } = {}) {
    // Admin is exempt from content screening and bans.
    if (isAdmin) return { ok: true };

    // Already banned?
    if (await isBanned(req, authUser)) {
        return { ok: false, status: 403, body: { error: 'account_suspended', message: 'Access has been suspended due to policy violations.' } };
    }

    const screen = screenContent(text);
    if (!screen.blocked) return { ok: true };

    const identity = resolveIdentity(req, authUser);
    const result   = await recordStrike(identity, screen.severity);

    // Never echo the matched category for CSAM; keep message generic.
    const base = "This request violates the content policy and has been blocked.";
    let message = base;
    if (result.action === 'warn') {
        message = `${base} Repeated violations will result in an automatic ban.`;
    } else if (result.action === 'temp_ban') {
        message = `${base} Your access has been temporarily suspended.`;
    } else if (result.action === 'long_ban') {
        message = `${base} Your access has been suspended.`;
    }

    // Log (without echoing raw user text for the worst category)
    const safeCat = screen.category === 'csam' ? '[redacted-zero-tolerance]' : screen.category;
    console.warn(`[CONTENT-GUARD] blocked category=${safeCat} severity=${screen.severity} identity=${identity.type}:${identity.value} action=${result.action} strikes=${result.strikes}`);

    return { ok: false, status: 403, body: { error: 'content_policy_violation', message } };
}
