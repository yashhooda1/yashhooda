// api/lib/weatherEnrichment.js
//
// Weather enrichment for activity records (Garmin / Strava).
//
// Why this exists: the FIT-file `averageTemperature` is a WRIST THERMISTOR
// reading. It blends ambient air with your own body heat + radiant sun off
// pavement, and it carries NO humidity signal at all. For cross-city heat
// comparisons (e.g. Houston vs Dallas) that's useless -- the entire difference
// between those climates is DEWPOINT, which the watch never measures. This
// module joins each activity to real hourly meteorology (Open-Meteo, free, no
// API key) keyed on lat/lon + UTC timestamp, then derives heat-stress features
// you can actually model on.
//
// ESM module -- matches the repo's "type":"module" convention.

import { pathToFileURL } from "node:url";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL  = "https://archive-api.open-meteo.com/v1/archive";

// ERA5 reanalysis (archive endpoint) lags ~5 days. The forecast endpoint
// serves recent history via past_days (up to 92). Pick based on activity age
// so a run from 2 days ago actually returns data.
function pickEndpoint(activityDateUTC) {
  const ageDays = (Date.now() - activityDateUTC.getTime()) / 86_400_000;
  return ageDays <= 90 ? FORECAST_URL : ARCHIVE_URL;
}

/**
 * Fetch hourly weather for a single lat/lon at the activity's UTC hour.
 * @returns {Promise<{tempF,dewpointF,humidityPct,apparentF,windMph}|null>}
 */
export async function getWeatherForActivity({ lat, lon, isoTimeGMT }) {
  if (lat == null || lon == null || !isoTimeGMT) return null;

  // Garmin gives e.g. "2026-07-03T23:57:35.0" (UTC, no Z). Normalize to a Date.
  const when = new Date(isoTimeGMT.endsWith("Z") ? isoTimeGMT : isoTimeGMT + "Z");
  if (Number.isNaN(when.getTime())) return null;

  const dateStr = when.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const hourKey = when.toISOString().slice(0, 13); // YYYY-MM-DDTHH

  const url = new URL(pickEndpoint(when));
  url.searchParams.set("latitude", Number(lat).toFixed(4));
  url.searchParams.set("longitude", Number(lon).toFixed(4));
  url.searchParams.set("start_date", dateStr);
  url.searchParams.set("end_date", dateStr);
  url.searchParams.set(
    "hourly",
    "temperature_2m,dewpoint_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "GMT");

  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error("[weatherEnrichment] fetch failed:", err.message);
    return null;
  }

  const times = data?.hourly?.time;
  if (!Array.isArray(times)) return null;

  // Match the activity's UTC hour; fall back to the nearest available hour.
  let i = times.findIndex((t) => t.startsWith(hourKey));
  if (i === -1) {
    const target = when.getTime();
    i = times.reduce(
      (best, t, idx) => {
        const d = Math.abs(new Date(t + ":00Z").getTime() - target);
        return d < best.d ? { d, idx } : best;
      },
      { d: Infinity, idx: -1 }
    ).idx;
  }
  if (i < 0) return null;

  const h = data.hourly;
  return {
    tempF:       h.temperature_2m?.[i]        ?? null,
    dewpointF:   h.dewpoint_2m?.[i]           ?? null,
    humidityPct: h.relative_humidity_2m?.[i]  ?? null,
    apparentF:   h.apparent_temperature?.[i]  ?? null,
    windMph:     h.wind_speed_10m?.[i]        ?? null,
  };
}

/**
 * NWS Rothfusz heat index (°F). Inputs: air temp °F, relative humidity %.
 * Uses the simple Steadman estimate first, escalating to the full regression
 * only when it's actually warm (the regression is only valid >~80°F).
 */
export function heatIndexF(T, R) {
  if (T == null || R == null) return null;

  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + R * 0.094);
  if ((simple + T) / 2 < 80) return round1((simple + T) / 2);

  let hi =
    -42.379 + 2.04901523 * T + 10.14333127 * R -
    0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R +
    0.00122874 * T * T * R + 0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  // Low-humidity and high-humidity adjustments per NWS.
  if (R < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (R > 85 && T >= 80 && T <= 87) {
    hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return round1(hi);
}

/**
 * Runner's temp+dewpoint heat-stress score (both °F, summed) -- the widely
 * used training heuristic. Higher sum = worse evaporative cooling = slower
 * sustainable pace at the same effort.
 * @returns {{sum:number, zone:string, paceImpact:string}|null}
 */
export function dewpointImpact(tempF, dewpointF) {
  if (tempF == null || dewpointF == null) return null;
  const sum = Math.round(tempF + dewpointF);
  const bands = [
    [100, "ideal",         "none"],
    [110, "very good",     "none"],
    [120, "comfortable",   "minimal"],
    [130, "manageable",    "slight — hard efforts start to cost"],
    [140, "uncomfortable", "moderate — expect ~2–4% slower"],
    [150, "difficult",     "notable — ~4–6% slower, ease targets"],
    [160, "hard",          "significant — ~6–8% slower, hydrate hard"],
    [170, "very hard",     "severe — quality work inadvisable"],
    [180, "dangerous",     "extreme — easy running only"],
    [Infinity, "extreme",  "hazardous — consider skipping"],
  ];
  const [, zone, paceImpact] = bands.find(([ceil]) => sum < ceil);
  return { sum, zone, paceImpact };
}

/**
 * Enrich a raw activity (Garmin summaryDTO shape, or a flat record) with a
 * `weather` block + derived heat features. Non-destructive: returns a new
 * object. Carries through the FIT wrist temperature so you can quantify how
 * wrong the watch was.
 *
 * Garmin stores averageTemperature in °C, so we convert for an apples-to-apples
 * delta against the real air temp.
 */
export async function enrichActivity(activity) {
  const s = activity.summaryDTO ?? activity;
  const lat = s.startLatitude;
  const lon = s.startLongitude;
  const isoTimeGMT = s.startTimeGMT ?? s.startTimeLocal;

  const wx = await getWeatherForActivity({ lat, lon, isoTimeGMT });
  if (!wx) return { ...activity, weather: null };

  const heatIndex = heatIndexF(wx.tempF, wx.humidityPct);
  const heatStress = dewpointImpact(wx.tempF, wx.dewpointF);

  const wristTempF =
    s.averageTemperature != null
      ? Math.round((s.averageTemperature * 9) / 5 + 32) // Garmin °C → °F
      : null;

  return {
    ...activity,
    weather: {
      source: "open-meteo",
      airTempF: wx.tempF,
      dewpointF: wx.dewpointF,
      humidityPct: wx.humidityPct,
      apparentTempF: wx.apparentF,
      windMph: wx.windMph,
      heatIndexF: heatIndex,
      heatStress, // { sum, zone, paceImpact }
      wristTempF, // from the watch, for comparison
      wristTempErrorF:
        wristTempF != null && wx.tempF != null
          ? Math.round(wristTempF - wx.tempF)
          : null,
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Local smoke test (Windows-safe):  node api/lib/weatherEnrichment.js
// ---------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const demo = {
    summaryDTO: {
      startLatitude: 32.98747,
      startLongitude: -96.75518,
      startTimeGMT: "2026-07-03T23:57:35.0",
      averageTemperature: 37.8, // Richardson wrist reading, °C
    },
  };
  enrichActivity(demo).then((r) => console.dir(r.weather, { depth: null }));
}
