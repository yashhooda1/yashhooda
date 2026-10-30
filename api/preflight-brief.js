// api/preflight-brief.js — ES Module ("type":"module" in package.json)
// ══════════════════════════════════════════════════════════════════════════════
// PREFLIGHT BRIEF — route → METAR / TAF / NOTAM → go / caution / no-go + brief.
// Site edition of the agent in yashhooda1/metar-stream (preflight_brief.py).
//
//   POST /api/preflight-brief
//     { route: "KAUS KHOU" | ["KAUS","KHOU"], profile?: "vfr_conservative"|"vfr_standard"|"ifr",
//       etd?: ISO-8601, ete?: hours, narrate?: boolean, adminPassword?: string }
//   → { verdict, stations[], profile, etd, ete_hours, narrative|null,
//       narrative_locked, model, taf_substitutes, cached_weather, disclaimer }
//
// Gating (site security rules):
//   • gate(): origin check + kill switch "preflight-brief" (auth 'none' — the
//     rules brief only hits free NOAA data, like /api/heat-conditions)
//   • rateLimit(): per-IP minute/hour + global daily cap
//   • the paid part — the LLM narrative — requires login (or admin); logged-out
//     visitors get the deterministic flags with narrative_locked: true
//   • weather cached 5 min per route; narratives cached 10 min per result hash
//
// Honesty design: lib/preflight.js decides the verdict. The model only writes
// the brief around flags it is handed and is told it cannot change them.
// Kill switch: SET killswitch:preflight-brief on
// ══════════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';
import { gate }      from '../lib/gateway.js';
import { rateLimit } from '../lib/rateLimit.js';
import { FAST_MODEL, anthropicWithFallback } from '../lib/models.js';
import { briefRoute, distanceNm, PROFILES } from '../lib/preflight.js';

export const maxDuration = 30;

const AWC = 'https://aviationweather.gov/api/data';
const FAA_NOTAM = 'https://external-api.faa.gov/notamapi/v1/notams';
const UA = { 'User-Agent': 'yashhooda.ai preflight-brief' };
const ICAO_RE = /^[A-Z0-9]{4}$/;
const WX_TTL = 300, NARR_TTL = 600;
const NEARBY_TAF_NM = 40;

const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function cached(key, ttl, fn) {
    try {
        const hit = await redis.get(key);
        if (hit) return { value: typeof hit === 'string' ? JSON.parse(hit) : hit, hit: true };
    } catch { /* cache is optional */ }
    const value = await fn();
    try { await redis.set(key, JSON.stringify(value), { ex: ttl }); } catch { /* ignore */ }
    return { value, hit: false };
}

async function awc(path, params) {
    const qs = new URLSearchParams({ format: 'json', ...params });
    const r = await fetch(`${AWC}/${path}?${qs}`, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (r.status === 204) return [];
    if (!r.ok) throw new Error(`AWC ${path} ${r.status}`);
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
}

const latestBy = (rows, timeKey) => {
    const out = {};
    for (const row of rows) {
        const id = String(row.icaoId || '').toUpperCase();
        if (!id) continue;
        if (!out[id] || (timeKey && (row[timeKey] || 0) > (out[id][timeKey] || 0))) out[id] = row;
    }
    return out;
};

async function fetchNotams(icao) {
    const id = process.env.FAA_CLIENT_ID, secret = process.env.FAA_CLIENT_SECRET;
    if (!id || !secret) return null;                         // → "not checked", never "none"
    try {
        const qs = new URLSearchParams({ icaoLocation: icao, responseFormatType: 'geoJson', pageSize: '100' });
        const r = await fetch(`${FAA_NOTAM}?${qs}`, { headers: { ...UA, client_id: id, client_secret: secret }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const body = await r.json();
        return (body.items || []).map(it => it?.properties?.coreNOTAMData?.notam).filter(n => n?.text).map(n => `${n.number || ''} ${n.text}`.trim());
    } catch { return null; }
}

async function gatherWeather(route) {
    const ids = [...new Set(route)];
    const [metars, tafs, notams] = await Promise.all([
        awc('metar', { ids: ids.join(','), hours: '2' }).then(r => latestBy(r, 'obsTime')),
        awc('taf', { ids: ids.join(',') }).then(r => latestBy(r, null)),
        Promise.all(ids.map(fetchNotams)),
    ]);
    const data = {};
    ids.forEach((icao, i) => {
        const m = metars[icao] || null, t = tafs[icao] || null;
        data[icao] = { metar: m, taf: t, notams: notams[i], lat: m?.lat ?? t?.lat ?? null, lon: m?.lon ?? t?.lon ?? null };
    });

    // Gap fill: departure / destination without a TAF borrow the nearest TAF
    // station within 40 nm. lib/preflight.js re-validates the distance.
    const substitutes = {};
    const ends = [route[0], route[route.length - 1]];
    await Promise.all([...new Set(ends)].map(async icao => {
        const e = data[icao];
        if (e.taf || typeof e.lat !== 'number') return;
        const dLat = NEARBY_TAF_NM / 60, dLon = dLat * 1.4;
        const bbox = [e.lat - dLat, e.lon - dLon, e.lat + dLat, e.lon + dLon].map(n => n.toFixed(2)).join(',');
        try {
            const near = Object.values(latestBy(await awc('taf', { bbox }), null))
                .map(t => ({ t, d: distanceNm(e.lat, e.lon, t.lat, t.lon) }))
                .filter(x => x.t.icaoId !== icao && x.d != null && x.d <= NEARBY_TAF_NM)
                .sort((a, b) => a.d - b.d)[0];
            if (near) {
                const id = near.t.icaoId.toUpperCase();
                data[id] = data[id] || { metar: null, taf: near.t, notams: [], lat: near.t.lat, lon: near.t.lon };
                substitutes[icao] = id;
            }
        } catch { /* a missing TAF stays flagged */ }
    }));
    return { data, substitutes };
}

const SYSTEM = `You are a careful flight-planning assistant writing a preflight weather brief for a general-aviation pilot, from data and flags produced by a deterministic rules engine.

Rules:
- The VERDICT is final and comes from the rules engine. Never contradict, soften or upgrade it. If it is NO_GO, say plainly the flight should not go as planned.
- Use ONLY the METARs, TAFs and flags provided. Never invent weather, NOTAMs, stations or times. If NOTAMs were not checked, say so.
- Pilot-to-pilot tone, concise, standard abbreviations, times in Zulu.
- Markdown with these sections: **Departure**, **Enroute** (omit if none), **Destination**, **Bottom line**. 120–220 words total.
- Final line exactly: _Not an official briefing — get a standard brief from 1800wxbrief.com._`;

function forModel(b) {
    return {
        verdict: b.verdict, etd: b.etd, ete_hours: b.ete_hours,
        minimums: { name: b.profile.name, ceiling_ft: b.profile.ceiling_ft, visibility_sm: b.profile.visibility_sm, wind_kt: b.profile.wind_kt, gust_kt: b.profile.gust_kt },
        stations: b.stations.map(s => ({
            station: s.station, role: s.role, eval_time: s.eval_time, verdict: s.verdict,
            category_now: s.category_now, worst_forecast_category: s.worst_forecast_category,
            metar: s.raw_metar, taf: s.raw_taf, taf_source: s.taf_source, notams_checked: s.notams_checked,
            flags: s.flags.map(f => `${f.severity} ${f.source}: ${f.message}`),
        })),
    };
}

async function narrate(brief) {
    const input = forModel(brief);
    const key = `preflight:narr:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)}`;
    return cached(key, NARR_TTL, async () => {
        const { res, data, model } = await anthropicWithFallback(process.env.ANTHROPIC_API_KEY, {
            model: FAST_MODEL, max_tokens: 3000, system: SYSTEM,       // no temperature: Claude 5 rejects sampling params
            messages: [{ role: 'user', content: `Brief this flight:\n\n${JSON.stringify(input, null, 1)}` }],
        });
        if (!res.ok) throw new Error(data?.error?.message || `anthropic ${res.status}`);
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (!text) throw new Error('empty narrative');
        return { text: text.slice(0, 4000), model };
    });
}

function parseRoute(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,>→-]+/);
    return list.map(s => String(s).trim().toUpperCase()).filter(Boolean);
}

export default async function handler(req, res) {
    const g = await gate(req, res, { endpoint: 'preflight-brief', methods: ['POST'], auth: 'none' });
    if (!g.ok) return;

    const allowed = await rateLimit(req, res, { endpoint: 'preflight-brief', maxPerMinute: 6, maxPerHour: 40, maxDailyGlobal: 1500 });
    if (!allowed) return;

    const route = parseRoute(req.body?.route);
    if (route.length < 1 || route.length > 5) return res.status(400).json({ error: 'bad_route', message: 'Enter 1–5 airports, departure first, e.g. "KAUS KHOU".' });
    const bad = route.filter(s => !ICAO_RE.test(s));
    if (bad.length) return res.status(400).json({ error: 'bad_route', message: `Not ICAO codes: ${bad.join(', ')} (use 4 letters, e.g. KAUS).` });

    const profile = PROFILES[req.body?.profile] ? req.body.profile : 'vfr_conservative';
    const ete = Number(req.body?.ete ?? 1);
    if (!(ete > 0 && ete <= 12)) return res.status(400).json({ error: 'bad_ete', message: 'ETE must be between 0 and 12 hours.' });
    const now = new Date();
    let etd = req.body?.etd ? new Date(req.body.etd) : now;
    if (Number.isNaN(etd.getTime())) return res.status(400).json({ error: 'bad_etd', message: 'Could not read the departure time.' });
    if (etd < now - 3600e3 || etd > now.getTime() + 30 * 3600e3) return res.status(400).json({ error: 'bad_etd', message: 'Departure must be within the TAF period (now to +30 h).' });

    let wx;
    try {
        wx = await cached(`preflight:wx:${route.join('-')}`, WX_TTL, () => gatherWeather(route));
    } catch (e) {
        console.error('[preflight-brief] weather fetch failed:', e.message);
        return res.status(502).json({ error: 'weather_unavailable', message: 'NOAA Aviation Weather is not responding. Try again shortly.' });
    }

    const brief = briefRoute(route, wx.value.data, { profile, etd, eteHours: ete, now, tafSubstitutes: wx.value.substitutes });

    const signedIn = !!(g.user || g.isAdmin);
    let narrative = null, model = null;
    if (req.body?.narrate !== false && signedIn && process.env.ANTHROPIC_API_KEY) {
        try { const n = await narrate(brief); narrative = n.value.text; model = n.value.model; }
        catch (e) { console.warn('[preflight-brief] narrative failed:', e.message); }
    }

    return res.status(200).json({
        ...brief,
        taf_substitutes: wx.value.substitutes,
        narrative, model,
        narrative_locked: !signedIn,
        cached_weather: wx.hit,
    });
}
