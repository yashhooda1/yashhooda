// api/agent-actions.js
// Proactive action recommendations engine
// Pulls from Strava + GitHub + time context
// Returns 2-4 prioritized action cards

import { notifyFailure } from './_notify.js';

export const maxDuration = 30;

// ── FETCH STRAVA SUMMARY ─────────────────────────────────────────────────────
async function getStravaSummary() {
  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return null;

    const res  = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=10',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const acts = await res.json();
    if (!Array.isArray(acts)) return null;

    const runs       = acts.filter(a => a.type === 'Run' || a.sport_type === 'Run');
    const now        = Date.now();
    const lastRun    = runs[0] ? new Date(runs[0].start_date).getTime() : null;
    const daysSince  = lastRun ? Math.floor((now - lastRun) / 86400000) : 99;

    // Weekly mileage (Mon–Sun)
    const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0,0,0,0);
    const weeklyMi   = runs
      .filter(r => new Date(r.start_date) >= weekStart)
      .reduce((s, r) => s + r.distance / 1609.34, 0);

    // Simple ATL/CTL approximation from recent runs
    const last7Days  = runs.filter(r => (now - new Date(r.start_date).getTime()) < 7 * 86400000);
    const last42Days = runs.filter(r => (now - new Date(r.start_date).getTime()) < 42 * 86400000);
    const atl        = last7Days.reduce((s, r) => s + r.distance / 1609.34, 0) / 7;
    const ctl        = last42Days.reduce((s, r) => s + r.distance / 1609.34, 0) / 42;
    const form       = ctl - atl;

    return { daysSince, weeklyMi: weeklyMi.toFixed(1), atl: atl.toFixed(1), ctl: ctl.toFixed(1), form: form.toFixed(1), lastRunName: runs[0]?.name || null };
  } catch { return null; }
}

// ── FETCH GITHUB SUMMARY ─────────────────────────────────────────────────────
async function getGitHubSummary() {
  try {
    const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'yashhooda-agent' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

    const res    = await fetch('https://api.github.com/users/yashhooda1/events/public?per_page=30', { headers });
    const events = await res.json();
    if (!Array.isArray(events)) return null;

    const pushEvents = events.filter(e => e.type === 'PushEvent');
    const lastPush   = pushEvents[0] ? new Date(pushEvents[0].created_at).getTime() : null;
    const daysSince  = lastPush ? Math.floor((Date.now() - lastPush) / 86400000) : 99;
    const lastRepo   = pushEvents[0]?.repo?.name?.replace('yashhooda1/', '') || null;

    // Count commits this week
    const weekStart   = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0,0,0,0);
    const weekCommits = pushEvents
      .filter(e => new Date(e.created_at) >= weekStart)
      .reduce((s, e) => s + (e.payload?.commits?.length || 0), 0);

    return { daysSince, lastRepo, weekCommits };
  } catch { return null; }
}

// ── GET WEATHER ──────────────────────────────────────────────────────────────
async function getHoustonWeather() {
  try {
    const res  = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=29.7604&longitude=-95.3698&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph'
    );
    const data = await res.json();
    const c    = data?.current;
    if (!c) return null;
    const tempF    = Math.round(c.temperature_2m);
    const humidity = c.relative_humidity_2m;
    const wind     = Math.round(c.wind_speed_10m);
    // Heat index risk for running
    const heatRisk = tempF >= 95 || (tempF >= 85 && humidity >= 70) ? 'extreme'
                   : tempF >= 88 || (tempF >= 80 && humidity >= 70) ? 'high'
                   : tempF >= 78 ? 'moderate' : 'low';
    return { tempF, humidity, wind, heatRisk };
  } catch { return null; }
}

// ── RECOMMENDATION ENGINE ────────────────────────────────────────────────────
function buildRecommendations(strava, github, weather, timeCtx) {
  const recs = [];

  // ── RUNNING RECOMMENDATIONS ──
  if (strava) {
    const form    = parseFloat(strava.form);
    const daysSince = strava.daysSince;
    const weekly  = parseFloat(strava.weeklyMi);

    if (daysSince >= 3) {
      recs.push({
        priority: 'high',
        category: 'running',
        emoji:    '🏃',
        title:    `${daysSince} days since your last run`,
        body:     `Last run: "${strava.lastRunName || 'unknown'}". Your weekly mileage is at ${weekly}mi. Time to lace up.`,
        action:   'Log a run on Strava',
        color:    '#fc4c02',
      });
    } else if (form < -15) {
      recs.push({
        priority: 'high',
        category: 'running',
        emoji:    '🔴',
        title:    'High training fatigue detected',
        body:     `Form score: ${strava.form} (ATL ${strava.atl} >> CTL ${strava.ctl}). Your body needs recovery before your next hard effort.`,
        action:   'Take an easy day or rest',
        color:    '#ef4444',
      });
    } else if (form > 5) {
      recs.push({
        priority: 'medium',
        category: 'running',
        emoji:    '⚡',
        title:    'Peak fitness window — race ready',
        body:     `Form score: +${strava.form}. CTL ${strava.ctl} with low fatigue. Great time for a tempo run or race effort.`,
        action:   'Schedule a quality workout',
        color:    '#4caf50',
      });
    }

    // Race countdown
    const raceDate  = new Date('2026-09-06'); // Boulderthon
    const daysToRace = Math.floor((raceDate - new Date()) / 86400000);
    if (daysToRace > 0 && daysToRace <= 90) {
      recs.push({
        priority: daysToRace <= 14 ? 'high' : 'medium',
        category: 'running',
        emoji:    '🏔️',
        title:    `Boulderthon in ${daysToRace} days`,
        body:     daysToRace <= 14
          ? `Taper time. Reduce mileage 20-30%, keep intensity, prioritize sleep. Boulder altitude = 5,400ft — factor in 3-5% slower paces.`
          : `On track for sub-3:00 marathon goal. Current weekly mileage: ${weekly}mi. Target: 50-55mpw peak.`,
        action:   daysToRace <= 14 ? 'Begin taper protocol' : 'Check training plan',
        color:    '#f97316',
      });
    }
  }

  // ── WEATHER RECOMMENDATIONS ──
  if (weather) {
    if (weather.heatRisk === 'extreme') {
      recs.push({
        priority: 'high',
        category: 'weather',
        emoji:    '🌡️',
        title:    `Extreme heat warning — ${weather.tempF}°F, ${weather.humidity}% humidity`,
        body:     `Houston heat index is dangerous for running. Shift workout to before 6am or after 7pm. Carry extra water, slow down 60-90 sec/mi.`,
        action:   'Adjust run time or go to treadmill',
        color:    '#ef4444',
      });
    } else if (weather.heatRisk === 'high') {
      recs.push({
        priority: 'medium',
        category: 'weather',
        emoji:    '☀️',
        title:    `High heat — ${weather.tempF}°F, ${weather.humidity}% humidity`,
        body:     `Slow your pace by 45-60 sec/mi. Hydrate before you leave. This is not a day for a PR attempt.`,
        action:   'Adjust run pace for conditions',
        color:    '#f97316',
      });
    }
  }

  // ── GITHUB / CAREER RECOMMENDATIONS ──
  if (github) {
    if (github.daysSince >= 3) {
      recs.push({
        priority: github.daysSince >= 7 ? 'high' : 'medium',
        category: 'career',
        emoji:    '🐙',
        title:    `${github.daysSince} days without a GitHub commit`,
        body:     `Last push was to ${github.lastRepo || 'a repo'}. Consistency on GitHub signals active engineering — even small commits count.`,
        action:   'Push a commit today',
        color:    '#facc15',
      });
    } else if (github.weekCommits >= 5) {
      recs.push({
        priority: 'low',
        category: 'career',
        emoji:    '🔥',
        title:    `Strong week — ${github.weekCommits} commits so far`,
        body:     `Great engineering velocity this week. Consider writing a LinkedIn post about what you shipped.`,
        action:   'Post an update on LinkedIn',
        color:    '#4caf50',
      });
    }
  }

  // ── TIME-BASED RECOMMENDATIONS ──
  const { hour, dayOfWeek } = timeCtx;
  const isMonday   = dayOfWeek === 1;
  const isFriday   = dayOfWeek === 5;
  const isMorning  = hour >= 5 && hour < 9;
  const isEvening  = hour >= 17 && hour < 21;

  if (isMonday && isMorning) {
    recs.push({
      priority: 'low',
      category: 'productivity',
      emoji:    '📋',
      title:    'Monday planning window',
      body:     'Set your 3 key outcomes for the week: one running goal, one work deliverable, one portfolio/career move.',
      action:   'Write your weekly priorities',
      color:    '#93c5fd',
    });
  }

  if (isFriday && isEvening) {
    recs.push({
      priority: 'low',
      category: 'career',
      emoji:    '🚀',
      title:    'End of week — deploy and share',
      body:     'Friday is a great time to push your latest changes to yashhooda.ai and share what you built this week on LinkedIn.',
      action:   'Deploy + post on LinkedIn',
      color:    '#86efac',
    });
  }

  // Sort by priority
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 4);
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const now        = new Date();
    const timeCtx    = { hour: now.getHours(), dayOfWeek: now.getDay(), date: now.toISOString().slice(0, 10) };

    const [strava, github, weather] = await Promise.all([
      getStravaSummary(),
      getGitHubSummary(),
      getHoustonWeather(),
    ]);

    const recommendations = buildRecommendations(strava, github, weather, timeCtx);

    return res.status(200).json({
      recommendations,
      context: { strava, github, weather, time: timeCtx },
      generatedAt: now.toISOString(),
    });

  } catch (err) {
    console.error('[AGENT-ACTIONS] Error:', err);
    await notifyFailure({ route: '/api/agent-actions', error: err });
    return res.status(500).json({ error: err.message });
  }
}
