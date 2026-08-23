// api/heat-conditions.js — live temp + dew point for the heat-adjusted pace tool.
// Source: NOAA Aviation Weather Center METAR feed (the same observations behind METAR Stream).
// Upstash Redis caching is optional: if the env vars are absent the endpoint still works.

const SOURCE = "https://aviationweather.gov/api/data/metar";
const CACHE_TTL_SECONDS = 300;
const STATION_RE = /^[A-Z0-9]{4}$/;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cacheGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.result ? JSON.parse(body.result) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL_SECONDS}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(value)
    });
  } catch {
    /* cache failures are never fatal */
  }
}

const cToF = (c) => (c * 9) / 5 + 32;

export default async function handler(req, res) {
  const raw = (req.query?.station || "KHOU").toString().trim().toUpperCase();

  if (!STATION_RE.test(raw)) {
    return res.status(400).json({ error: "Station must be a 4-character ICAO code, like KHOU." });
  }

  const cacheKey = `heatpace:metar:${raw}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    return res.status(200).json({ ...cached, cached: true });
  }

  let report;
  try {
    const url = `${SOURCE}?ids=${raw}&format=json&hours=3`;
    const upstream = await fetch(url, {
      headers: { "User-Agent": "yashhooda.ai heat-pace tool" },
      signal: AbortSignal.timeout(6000)
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const rows = await upstream.json();
    report = Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    return res.status(502).json({ error: "Weather feed unavailable", detail: String(err.message || err) });
  }

  if (!report || typeof report.temp !== "number" || typeof report.dewp !== "number") {
    return res.status(404).json({ error: `No recent temperature report for ${raw}.` });
  }

  const observedAt = report.obsTime ? new Date(report.obsTime * 1000).toISOString() : null;
  const payload = {
    station: report.icaoId || raw,
    name: report.name || null,
    tempC: report.temp,
    dewpC: report.dewp,
    tempF: Math.round(cToF(report.temp) * 10) / 10,
    dewpF: Math.round(cToF(report.dewp) * 10) / 10,
    sumF: Math.round(cToF(report.temp) + cToF(report.dewp)),
    windKt: typeof report.wspd === "number" ? report.wspd : null,
    windDir: typeof report.wdir === "number" ? report.wdir : null,
    observedAt,
    observedAgoMin: report.obsTime
      ? Math.max(0, Math.round((Date.now() / 1000 - report.obsTime) / 60))
      : null,
    rawMetar: report.rawOb || null,
    source: "NOAA Aviation Weather Center",
    cached: false
  };

  await cacheSet(cacheKey, payload);

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
  return res.status(200).json(payload);
}
