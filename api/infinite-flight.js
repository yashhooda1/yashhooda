// api/infinite-flight.js
// Infinite Flight live tracker for yashhooda.ai
//
// GET  /api/infinite-flight            -> current flight (live), last flight, or idle
// POST /api/infinite-flight            -> log an offline / Autopilot+ flight manually
//        headers: x-if-token: $IF_ADMIN_TOKEN
//        body:    { origin, destination, aircraft, callsign, waypoints:[["KIAH",29.98,-95.34], ...],
//                   startedAt, endedAt, note }
//        body:    { clear: true }       -> wipe the manual entry
//
// Env vars:
//   IF_API_KEY               Infinite Flight Live API key
//   IF_USERNAME              your Infinite Flight community username (case-insensitive match)
//   IF_ADMIN_TOKEN           shared secret for POSTing offline flights
//   UPSTASH_REDIS_REST_URL   (already set on this project)
//   UPSTASH_REDIS_REST_TOKEN (already set on this project)

const API = "https://api.infiniteflight.com/public/v2";

const KEY_LIVE = "if:live";        // hot cache of the current live payload  (20s)
const KEY_LAST = "if:last";        // most recent completed flight            (60d)
const KEY_SEEN = "if:seen";        // first-sighting timestamp per flightId   (12h)
const KEY_FLEET = "if:fleet";      // aircraftId -> name map                  (24h)
const KEY_MANUAL = "if:manual";    // manually posted offline flight          (60d)

/* ------------------------------------------------------------------ redis */

const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(R_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ?? null;
  } catch {
    return null;
  }
}

async function rGet(key) {
  const v = await redis(["GET", key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function rSet(key, value, ttlSeconds) {
  const cmd = ["SET", key, JSON.stringify(value)];
  if (ttlSeconds) cmd.push("EX", String(ttlSeconds));
  return redis(cmd);
}

/* -------------------------------------------------------------- if client */

async function ifGet(path) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.IF_API_KEY}` },
  });
  if (!r.ok) throw new Error(`IF ${path} -> ${r.status}`);
  const j = await r.json();
  // Live API v2 wraps everything as { errorCode, result }
  if (j && typeof j === "object" && "errorCode" in j) {
    if (j.errorCode !== 0) throw new Error(`IF ${path} errorCode ${j.errorCode}`);
    return j.result;
  }
  return j;
}

/* ------------------------------------------------------------------ geo */

const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;

function nm(a, b) {
  if (!a || !b) return 0;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathNm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += nm(points[i - 1], points[i]);
  return total;
}

/* -------------------------------------------------------- flight plan */

// flightPlanItems is a tree: SIDs/STARs/airways carry `children`.
// Flatten to leaves so we get every real fix with coordinates.
function flattenPlan(items, out = []) {
  for (const it of items || []) {
    if (it.children && it.children.length) {
      flattenPlan(it.children, out);
    } else if (it.location && (it.location.latitude || it.location.longitude)) {
      out.push({
        name: it.identifier || it.name || "",
        lat: it.location.latitude,
        lon: it.location.longitude,
        altitude: it.altitude ?? null,
      });
    }
  }
  return out;
}

const isIcao = (s) => /^[A-Z]{4}$/.test(s || "");

function endpointsFrom(leaves) {
  const origin = leaves.find((w) => isIcao(w.name)) || leaves[0] || null;
  const dest =
    [...leaves].reverse().find((w) => isIcao(w.name)) ||
    leaves[leaves.length - 1] ||
    null;
  return { origin, dest: dest === origin ? null : dest };
}

/* ------------------------------------------------------------ fleet names */

async function aircraftName(aircraftId) {
  if (!aircraftId) return null;
  let fleet = await rGet(KEY_FLEET);
  if (!fleet) {
    try {
      const list = await ifGet("/aircraft");
      fleet = Object.fromEntries((list || []).map((a) => [a.id, a.name]));
      await rSet(KEY_FLEET, fleet, 86400);
    } catch {
      return null;
    }
  }
  return fleet[aircraftId] || null;
}

/* ------------------------------------------------------------ find flight */

async function findLiveFlight(username) {
  const sessions = await ifGet("/sessions");
  // Expert first — that's where the route endpoint is richest.
  const ordered = [...(sessions || [])].sort((a, b) => {
    const rank = (s) => (/expert/i.test(s.name) ? 0 : /training/i.test(s.name) ? 1 : 2);
    return rank(a) - rank(b);
  });

  const want = (username || "").toLowerCase();
  for (const s of ordered) {
    let flights;
    try {
      flights = await ifGet(`/sessions/${s.id}/flights`);
    } catch {
      continue;
    }
    const mine = (flights || []).find(
      (f) => (f.username || "").toLowerCase() === want
    );
    if (mine) return { session: s, flight: mine };
  }
  return null;
}

async function buildLivePayload(session, flight) {
  const [planRaw, routeRaw, acName] = await Promise.all([
    ifGet(`/sessions/${session.id}/flights/${flight.flightId}/flightplan`).catch(() => null),
    ifGet(`/sessions/${session.id}/flights/${flight.flightId}/route`).catch(() => null),
    aircraftName(flight.aircraftId),
  ]);

  const leaves = flattenPlan(planRaw?.flightPlanItems);
  const { origin, dest } = endpointsFrom(leaves);

  const track = (routeRaw || [])
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({
      lat: p.latitude,
      lon: p.longitude,
      alt: p.altitude,
      gs: p.groundSpeed,
      t: p.date,
    }));

  // Start time: first route sample if available, otherwise the first moment
  // this endpoint ever saw the flight (Casual server has no route history).
  let startedAt = track[0]?.t || null;
  if (!startedAt) {
    const seenKey = `${KEY_SEEN}:${flight.flightId}`;
    let seen = await rGet(seenKey);
    if (!seen) {
      seen = new Date().toISOString();
      await rSet(seenKey, seen, 43200);
    }
    startedAt = seen;
  }

  const here = { lat: flight.latitude, lon: flight.longitude };
  const flownNm = track.length > 1 ? pathNm(track) : 0;
  const totalNm =
    origin && dest ? pathNm([origin, ...leaves.slice(1, -1), dest]) : flownNm;
  const remainingNm = dest ? nm(here, dest) : null;

  let progressPct = null;
  if (totalNm > 0 && remainingNm != null) {
    progressPct = Math.max(0, Math.min(100, ((totalNm - remainingNm) / totalNm) * 100));
  }

  const durationSec = startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
    : null;

  let etaSec = null;
  if (remainingNm != null && flight.speed > 40) {
    etaSec = Math.round((remainingNm / flight.speed) * 3600);
  }

  return {
    status: "live",
    mode: "online",
    server: session.name,
    flightId: flight.flightId,
    callsign: flight.callsign || null,
    username: flight.username || null,
    virtualOrganization: flight.virtualOrganization || null,
    aircraft: acName,
    origin: origin ? { icao: origin.name, lat: origin.lat, lon: origin.lon } : null,
    destination: dest ? { icao: dest.name, lat: dest.lat, lon: dest.lon } : null,
    waypoints: leaves.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
    position: {
      lat: flight.latitude,
      lon: flight.longitude,
      altitudeFt: flight.altitude,
      groundSpeedKts: flight.speed,
      verticalSpeedFpm: flight.verticalSpeed,
      headingDeg: flight.heading,
      trackDeg: flight.track,
    },
    track: track.map((p) => [p.lat, p.lon]),
    startedAt,
    durationSec,
    etaSec,
    distanceNm: {
      flown: Math.round(flownNm),
      total: Math.round(totalNm),
      remaining: remainingNm == null ? null : Math.round(remainingNm),
    },
    progressPct: progressPct == null ? null : Math.round(progressPct),
    updatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- handlers */

async function handlePost(req, res) {
  const token = req.headers["x-if-token"];
  if (!process.env.IF_ADMIN_TOKEN || token !== process.env.IF_ADMIN_TOKEN) {
    return res.status(401).json({ error: "Bad or missing x-if-token." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  if (body.clear) {
    await redis(["DEL", KEY_MANUAL]);
    return res.status(200).json({ ok: true, cleared: true });
  }

  if (!body.origin || !body.destination) {
    return res.status(400).json({ error: "origin and destination are required." });
  }

  // waypoints: [["KIAH", 29.98, -95.34], ["DAS", 31.1, -94.0], ...]
  const waypoints = (body.waypoints || []).map((w) =>
    Array.isArray(w) ? { name: w[0], lat: w[1], lon: w[2] } : w
  );

  const started = body.startedAt ? new Date(body.startedAt) : null;
  const ended = body.endedAt ? new Date(body.endedAt) : null;

  const entry = {
    status: "last",
    mode: "offline",
    server: "Solo / Autopilot+",
    callsign: body.callsign || null,
    aircraft: body.aircraft || null,
    origin: waypoints[0] || { icao: body.origin },
    destination: waypoints[waypoints.length - 1] || { icao: body.destination },
    waypoints,
    track: waypoints.map((w) => [w.lat, w.lon]).filter((p) => p[0] != null),
    startedAt: started ? started.toISOString() : null,
    endedAt: ended ? ended.toISOString() : null,
    durationSec:
      started && ended ? Math.max(0, Math.floor((ended - started) / 1000)) : body.durationSec ?? null,
    distanceNm: { total: Math.round(pathNm(waypoints.filter((w) => w.lat != null))) },
    note: body.note || null,
    updatedAt: new Date().toISOString(),
  };

  // Normalize the ICAO fields whether or not coords were supplied.
  entry.origin = { icao: body.origin, lat: entry.origin.lat ?? null, lon: entry.origin.lon ?? null };
  entry.destination = {
    icao: body.destination,
    lat: entry.destination.lat ?? null,
    lon: entry.destination.lon ?? null,
  };

  await rSet(KEY_MANUAL, entry, 60 * 60 * 24 * 60);
  return res.status(200).json({ ok: true, entry });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-if-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "POST") {
    try {
      return await handlePost(req, res);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  if (!process.env.IF_API_KEY || !process.env.IF_USERNAME) {
    return res.status(500).json({ error: "IF_API_KEY and IF_USERNAME are not configured." });
  }

  // Serve the hot cache first — this endpoint can be polled hard from the browser
  // without touching the Live API more than once every 20 seconds.
  const cached = await rGet(KEY_LIVE);
  if (cached) {
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json({ ...cached, cached: true });
  }

  try {
    const found = await findLiveFlight(process.env.IF_USERNAME);

    if (found) {
      const payload = await buildLivePayload(found.session, found.flight);
      await rSet(KEY_LIVE, payload, 20);
      // Keep a copy so the site still has something to show after landing.
      await rSet(KEY_LAST, { ...payload, status: "last", endedAt: null }, 60 * 60 * 24 * 60);
      res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
      return res.status(200).json(payload);
    }

    // Not airborne online. Show whichever record is newer: the last live flight
    // or a manually logged offline flight.
    const [last, manual] = await Promise.all([rGet(KEY_LAST), rGet(KEY_MANUAL)]);
    const newest =
      last && manual
        ? new Date(manual.updatedAt) > new Date(last.updatedAt)
          ? manual
          : last
        : manual || last;

    const payload = newest
      ? { ...newest, status: "last" }
      : { status: "idle", updatedAt: new Date().toISOString() };

    await rSet(KEY_LIVE, payload, 60);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(payload);
  } catch (e) {
    const fallback = (await rGet(KEY_LAST)) || (await rGet(KEY_MANUAL));
    if (fallback) {
      return res.status(200).json({ ...fallback, status: "last", degraded: e.message });
    }
    return res.status(502).json({ error: e.message });
  }
}
