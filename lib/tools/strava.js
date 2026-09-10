// lib/tools/strava.js
// Deterministic, read-only Strava tools for the site agent.
// The LLM never computes training numbers — it calls these and explains the output.
// Uses the same STRAVA_* env vars as api/strava.js. Activities cached in Redis for 10 min.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MI      = 1609.34;
const HR_REST = Number(process.env.ATHLETE_HR_REST || 50);
const HR_MAX  = Number(process.env.ATHLETE_HR_MAX  || 190);

// ── DATA ────────────────────────────────────────────────────────────────────
async function accessToken() {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('strava_auth_failed');
  return j.access_token;
}

// Last ~90 days of activities, trimmed to the fields the tools need.
export async function loadActivities() {
  const key = 'agent:strava:acts:v1';
  try { const c = await redis.get(key); if (c) return c; } catch {}

  const token = await accessToken();
  const after = Math.floor(Date.now() / 1000) - 90 * 86400;
  const r = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=200&after=${after}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const raw = await r.json();
  if (!Array.isArray(raw)) throw new Error('strava_fetch_failed');

  const acts = raw.map(a => ({
    id:       a.id,
    name:     a.name,
    type:     a.sport_type || a.type,
    date:     a.start_date_local,
    miles:    +(a.distance / MI).toFixed(2),
    movingMin:+(a.moving_time / 60).toFixed(1),
    paceSec:  a.distance > 0 ? Math.round(a.moving_time / (a.distance / MI)) : null,
    avgHr:    a.average_heartrate ? Math.round(a.average_heartrate) : null,
    elevFt:   Math.round((a.total_elevation_gain || 0) * 3.281),
  }));
  try { await redis.set(key, acts, { ex: 600 }); } catch {}
  return acts;
}

// ── MATH (pure) ─────────────────────────────────────────────────────────────
const fmtPace = s => s == null ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}/mi`;
const fmtTime = s => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
};
const isRun = a => a.type === 'Run' || a.type === 'TrailRun' || a.type === 'VirtualRun';

// Banister TRIMP. Falls back to a distance proxy when there's no HR.
export function trimp(a) {
  if (a.avgHr && a.movingMin) {
    const hrr = Math.min(1, Math.max(0, (a.avgHr - HR_REST) / (HR_MAX - HR_REST)));
    return a.movingMin * hrr * 0.64 * Math.exp(1.92 * hrr);
  }
  return a.miles * 10;
}

// Exponentially-weighted CTL (42 d) / ATL (7 d) over a daily load series.
export function trainingLoad(acts, days = 90) {
  const daily = new Map();
  for (const a of acts) {
    if (!isRun(a)) continue;
    const d = a.date.slice(0, 10);
    daily.set(d, (daily.get(d) || 0) + trimp(a));
  }
  let ctl = 0, atl = 0;
  const kC = 1 - Math.exp(-1 / 42), kA = 1 - Math.exp(-1 / 7);
  const start = new Date(); start.setDate(start.getDate() - days);
  for (let i = 0; i <= days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const load = daily.get(d.toISOString().slice(0, 10)) || 0;
    ctl += kC * (load - ctl);
    atl += kA * (load - atl);
  }
  const form  = ctl - atl;
  const acwr  = ctl > 0 ? atl / ctl : null;
  const state = form < -20 ? 'fatigued' : form < -5 ? 'productive' : form < 10 ? 'fresh' : 'detraining';
  const risk  = acwr == null ? 'unknown' : acwr > 1.5 ? 'high' : acwr > 1.3 ? 'elevated' : acwr < 0.8 ? 'undertraining' : 'normal';
  return {
    ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), form: +form.toFixed(1),
    acwr: acwr == null ? null : +acwr.toFixed(2),
    state, injuryRisk: risk,
    thresholds: { form: 'fatigued < -20, productive -20..-5, fresh -5..10', acwr: 'normal 0.8-1.3, elevated >1.3, high >1.5' },
    loadModel: 'Banister TRIMP (HR-based; miles*10 fallback), EWMA 42d/7d',
  };
}

export function weeklyMileage(acts, weeks = 8) {
  const out = [];
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(0,0,0,0);
  for (let w = 0; w < weeks; w++) {
    const start = new Date(monday); start.setDate(monday.getDate() - 7 * w);
    const end   = new Date(start);  end.setDate(start.getDate() + 7);
    const runs  = acts.filter(a => isRun(a) && new Date(a.date) >= start && new Date(a.date) < end);
    out.push({
      weekOf:  start.toISOString().slice(0, 10),
      miles:   +runs.reduce((s, r) => s + r.miles, 0).toFixed(1),
      runs:    runs.length,
      longest: +Math.max(0, ...runs.map(r => r.miles)).toFixed(1),
    });
  }
  return out;
}

const DIST = { '5K': 5000, '10K': 10000, 'half': 21097.5, 'marathon': 42195, '10mi': 16093.4, 'mile': 1609.34 };

// Riegel equivalence: T2 = T1 * (D2/D1)^1.06
export function racePredictor({ distance, timeSeconds }) {
  const d1 = DIST[distance];
  if (!d1) throw new Error(`unknown distance "${distance}"; use one of ${Object.keys(DIST).join(', ')}`);
  const pred = {};
  for (const [k, d2] of Object.entries(DIST)) {
    const t = timeSeconds * Math.pow(d2 / d1, 1.06);
    pred[k] = { time: fmtTime(t), pace: fmtPace(Math.round(t / (d2 / MI))) };
  }
  return { input: { distance, time: fmtTime(timeSeconds) }, model: 'Riegel, exponent 1.06', predictions: pred };
}

// ── MCP-SHAPED TOOL DEFINITIONS ─────────────────────────────────────────────
export const stravaTools = [
  {
    name: 'strava_recent_activities',
    description: "List Yash's recent Strava activities (runs, swims, walks, etc.) with distance, pace, HR and date. Use for questions about what he ran recently.",
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 }, runsOnly: { type: 'boolean', default: false } } },
    handler: async ({ limit = 15, runsOnly = false }) => {
      const acts = await loadActivities();
      return (runsOnly ? acts.filter(isRun) : acts).slice(0, limit).map(a => ({ ...a, pace: fmtPace(a.paceSec), paceSec: undefined }));
    },
  },
  {
    name: 'strava_training_load',
    description: "Deterministic fitness/fatigue analysis: CTL (42-day fitness), ATL (7-day fatigue), Form, acute:chronic workload ratio and injury-risk band, with the thresholds used. Use for 'am I overtraining', 'should I run today', 'how is my fitness'.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => trainingLoad(await loadActivities()),
  },
  {
    name: 'strava_weekly_mileage',
    description: 'Weekly running mileage, run count and longest run for the last N weeks (Mon–Sun).',
    inputSchema: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 12, default: 8 } } },
    handler: async ({ weeks = 8 }) => weeklyMileage(await loadActivities(), weeks),
  },
  {
    name: 'race_predictor',
    description: 'Predict equivalent race times at other distances from one result using the Riegel formula. distance is one of mile, 5K, 10K, 10mi, half, marathon.',
    inputSchema: {
      type: 'object', required: ['distance', 'timeSeconds'],
      properties: { distance: { type: 'string', enum: Object.keys(DIST) }, timeSeconds: { type: 'integer', minimum: 60 } },
    },
    handler: async args => racePredictor(args),
  },
];
