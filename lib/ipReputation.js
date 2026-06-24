// lib/ipReputation.js
// ══════════════════════════════════════════════════════════════════════════════
// IP REPUTATION CHECK — block datacenter / VPN / proxy signups
//
// The problem this solves: a troll rotating through VPN IPs can't be stopped by
// banning individual addresses. But VPN/hosting IPs share a trait real users
// rarely have at signup — they belong to datacenter ASNs. We check that instead.
//
// Strategy (layered, cheap → thorough):
//   1. Local CIDR blocklist of known abusive hosting ranges (instant, free).
//   2. Optional ipinfo.io / proxycheck lookup for ASN + privacy flags (1 API call,
//      cached in Redis 7 days so each IP is only ever looked up once).
//
// Admin is never checked (handled by the caller).
// Fails OPEN: if a lookup errors, we allow the signup rather than block real users.
// ══════════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── 1. STATIC CIDR BLOCKLIST ──────────────────────────────────────────────────
// Ranges seen attacking the site + common abusive VPN/hosting blocks.
// Add new ranges here as you spot them in [TRACE] logs.
const BLOCKED_CIDRS = [
    '149.40.62.0/24',   // attacker range (datacenter)
    '146.70.202.0/24',  // attacker range (M247 / VPN)
    '146.70.0.0/16',    // M247 — large VPN host (Surfshark/others)
    '149.40.0.0/16',    // datacenter block
    '45.83.0.0/16',     // common VPN host
    '185.220.0.0/16',   // Tor / abusive
    '193.32.0.0/16',    // VPN host
    '212.102.35.0/24'
];

// Convert an IPv4 string to a 32-bit integer.
function ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const o = Number(p);
        if (!Number.isInteger(o) || o < 0 || o > 255) return null;
        n = (n << 8) + o;
    }
    return n >>> 0;
}

function ipInCidr(ip, cidr) {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const ipInt = ipToInt(ip);
    const rangeInt = ipToInt(range);
    if (ipInt === null || rangeInt === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
}

function inStaticBlocklist(ip) {
    return BLOCKED_CIDRS.some(cidr => ipInCidr(ip, cidr));
}

// ── 2. ASN / PRIVACY LOOKUP (ipinfo.io) ───────────────────────────────────────
// Requires IPINFO_TOKEN env var (free tier = 50k lookups/mo). If not set, this
// layer is skipped and only the static blocklist applies.
async function lookupIpReputation(ip) {
    const token = process.env.IPINFO_TOKEN;
    if (!token) return null;

    // Cache: each IP looked up at most once per 7 days.
    const cacheKey = `iprep:${ip}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached) return cached; // { isHosting, asn, org } or { clean: true }
    } catch {}

    try {
        const r = await fetch(`https://ipinfo.io/${ip}/json?token=${token}`, {
            signal: AbortSignal.timeout(2500),
        });
        if (!r.ok) return null;
        const data = await r.json();

        // ipinfo privacy fields (paid) or org/asn heuristic (free).
        const org = (data.org || '').toLowerCase();
        const isHosting =
            data.privacy?.hosting === true ||
            data.privacy?.vpn === true ||
            data.privacy?.proxy === true ||
            data.privacy?.tor === true ||
            /\b(hosting|datacenter|data center|vps|server|cloud|m247|ovh|digitalocean|linode|vultr|hetzner|leaseweb|choopa|colocation|nforce)\b/.test(org);

        const result = { isHosting, org: data.org || '', asn: data.asn?.asn || '' };
        try { await redis.set(cacheKey, result, { ex: 60 * 60 * 24 * 7 }); } catch {}
        return result;
    } catch {
        return null; // network error → fail open
    }
}

// ── MAIN: should this IP be blocked from signing up? ──────────────────────────
// Returns { blocked: bool, reason: string }.
export async function checkSignupIp(ip) {
    if (!ip || ip === 'unknown') return { blocked: false, reason: 'no_ip' };

    // Layer 1 — static CIDR blocklist (instant).
    if (inStaticBlocklist(ip)) {
        return { blocked: true, reason: 'blocked_range' };
    }

    // Layer 2 — ASN / privacy lookup (cached).
    const rep = await lookupIpReputation(ip);
    if (rep?.isHosting) {
        return { blocked: true, reason: 'datacenter_vpn' };
    }

    return { blocked: false, reason: 'ok' };
}

// Expose the CIDR helper so other modules (e.g. a middleware) can reuse it.
export { inStaticBlocklist, ipInCidr };
