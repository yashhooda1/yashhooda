import { Redis } from '@upstash/redis';

export const maxDuration = 60;

// ── 30-MIN RESPONSE CACHE ─────────────────────────────────────────────────────
// One Strava pull + one Claude call per 30 min for the whole site, regardless
// of how many visitors (or bots) load the homepage.
const CACHE_KEY = 'analytics:homepage:v1';
const CACHE_TTL = 1800; // seconds

const cacheRedis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  // Cache hit → return immediately, zero API spend
  if (cacheRedis) {
    try {
      const cached = await cacheRedis.get(CACHE_KEY);
      if (cached) {
        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(typeof cached === 'string' ? JSON.parse(cached) : cached);
      }
    } catch (e) {
      console.error('[ANALYTICS] cache read failed:', e.message);
    }
  }

  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
  const openaikey = process.env.OPENAI_API_KEY;

  try {
    // 1. Get Strava access token
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const tokenData = await tokenRes.json();
    const access_token = tokenData?.access_token;
    if (!access_token) {
      console.error('Strava token exchange failed:', JSON.stringify(tokenData).slice(0, 300));
      return res.status(502).json({ error: 'Strava auth failed', detail: tokenData });
    }

    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=60&page=1', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const activities = await actRes.json();

    if (!Array.isArray(activities)) {
      console.error(`Strava activities ${actRes.status}:`, JSON.stringify(activities).slice(0, 300));
      return res.status(502).json({ error: 'Strava activities unavailable', detail: activities });
    }

    const runs = activities.filter(a => a.type === 'Run');

    // 4. ── WEEKLY MILEAGE TREND (last 8 weeks) ──
    const weeklyTrend = [];
    for (let i = 7; i >= 0; i--) {
      const weekStart = new Date();
      const day = weekStart.getDay();
      const daysFromMonday = day === 0 ? 6 : day - 1;
      weekStart.setDate(weekStart.getDate() - daysFromMonday - (i * 7));
      weekStart.setHours(0,0,0,0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23,59,59,999);
      const miles = runs
        .filter(r => { const d = new Date(r.start_date_local); return d >= weekStart && d <= weekEnd; })
        .reduce((sum, r) => sum + r.distance / 1609.34, 0);
      const label = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      weeklyTrend.push({ week: label, miles: parseFloat(miles.toFixed(1)) });
    }

    // 5. ── ATL / CTL / FORM ──
    const today = new Date();
    let ctl = 0, atl = 0;
    for (let i = 41; i >= 0; i--) {
      const day = new Date(today);
      day.setDate(today.getDate() - i);
      const dayStart = new Date(day); dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(day); dayEnd.setHours(23,59,59,999);
      const dayLoad = runs
        .filter(r => { const d = new Date(r.start_date_local); return d >= dayStart && d <= dayEnd; })
        .reduce((sum, r) => sum + (r.suffer_score || (r.distance / 1609.34) * 10), 0);
      ctl = ctl + (dayLoad - ctl) / 42;
      atl = atl + (dayLoad - atl) / 7;
    }
    const form = parseFloat((ctl - atl).toFixed(1));
    const ctlRounded = parseFloat(ctl.toFixed(1));
    const atlRounded = parseFloat(atl.toFixed(1));

    // 6. ── PACE ZONE BREAKDOWN ──
    let easy = 0, moderate = 0, threshold = 0, hard = 0;
    runs.slice(0, 30).forEach(r => {
      if (!r.average_heartrate) return;
      const hr = r.average_heartrate;
      if (hr < 150) easy++;
      else if (hr < 160) moderate++;
      else if (hr < 170) threshold++;
      else hard++;
    });
    const total = easy + moderate + threshold + hard || 1;
    const paceZones = {
      easy: Math.round(easy/total*100),
      moderate: Math.round(moderate/total*100),
      threshold: Math.round(threshold/total*100),
      hard: Math.round(hard/total*100),
    };

    // 7. ── RACE PREDICTIONS (Riegel formula) ──
    const basePRs = { 'mile': 4*60+58, '5K': 18*60+15, 'Half': 84*60+31 };
    function riegel(baseTimeSec, baseDist, targetDist) {
      return baseTimeSec * Math.pow(targetDist / baseDist, 1.06);
    }
    function fmtTime(sec) {
      const h = Math.floor(sec/3600);
      const m = Math.floor((sec%3600)/60);
      const s = Math.round(sec%60).toString().padStart(2,'0');
      return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${s}` : `${m}:${s}`;
    }
    const predictions = {
      'mile':    { predicted: fmtTime(basePRs['mile']),                         pr: '4:58',    gap: '0:00' },
      '5K':      { predicted: fmtTime(basePRs['5K']),                           pr: '18:15',   gap: '0:00' },
      '10K':     { predicted: fmtTime(riegel(basePRs['5K'], 5000, 10000)),      pr: 'N/A',     gap: null },
      'Half':    { predicted: fmtTime(basePRs['Half']),                         pr: '1:24:31', gap: '0:00' },
      'Marathon':{ predicted: fmtTime(riegel(basePRs['Half'], 21097.5, 42195)), pr: 'TBD',     gap: null },
    };
    function timeDiff(a, b) {
      const parse = t => { const p = t.split(':').map(Number); return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1]; };
      const diff = parse(b) - parse(a);
      if (diff <= 0) return '🏆 At PR';
      const m = Math.floor(diff/60), s = diff%60;
      return `+${m}:${s.toString().padStart(2,'0')} from PR`;
    }
    predictions['mile'].gap = timeDiff(predictions['mile'].predicted, '4:58');
    predictions['5K'].gap   = timeDiff(predictions['5K'].predicted,   '18:15');
    predictions['Half'].gap = timeDiff(predictions['Half'].predicted,  '1:24:31');

    // 8. ── WEATHER PER RUN (Open-Meteo Archive API) ──
    async function getRunWeather(lat, lon, dateStr) {
      try {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
          `&start_date=${dateStr}&end_date=${dateStr}` +
          `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,apparent_temperature` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
        const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        const d = await r.json();
        const temps     = d.hourly?.temperature_2m       || [];
        const humidity  = d.hourly?.relative_humidity_2m || [];
        const feelsLike = d.hourly?.apparent_temperature || [];
        const wind      = d.hourly?.wind_speed_10m       || [];
        const gustArr   = d.hourly?.wind_gusts_10m       || [];
        const sliceArr  = (arr) => arr.slice(10, 14).filter(v => v !== null);
        const avg       = (arr) => arr.length ? arr.reduce((a,b) => a+b,0)/arr.length : null;
        const tempF    = avg(sliceArr(temps));
        const humidPct = avg(sliceArr(humidity));
        const feelsF   = avg(sliceArr(feelsLike));
        const windMph  = avg(sliceArr(wind));
        const gustMph  = avg(sliceArr(gustArr));
        if (tempF === null) return null;
        const tempC = (tempF - 32) * 5/9;
        const w     = windMph || 0;
        const g     = gustMph || w;

        // ── HEAT (El Helou 2012, Ely 2007) — unchanged ──
        let perfImpact = 0;
        if      (tempC <= 15) perfImpact = 0;
        else if (tempC <= 20) perfImpact = -1.5;
        else if (tempC <= 25) perfImpact = -4;
        else if (tempC <= 30) perfImpact = -10;
        else if (tempC <= 35) perfImpact = -17;
        else                  perfImpact = -25;
        if (humidPct >= 70 && tempC > 20) perfImpact -= (humidPct - 70) * 0.1;

        // ── WIND CHILL (NWS formula — only valid at <=50F with wind >3mph) ──
        const windChillF = (tempF <= 50 && w > 3)
          ? Math.round(35.74 + 0.6215 * tempF - 35.75 * Math.pow(w, 0.16) + 0.4275 * tempF * Math.pow(w, 0.16))
          : Math.round(tempF);

        // ── COLD PENALTY ──
        // Small and driven by footing, clothing weight, and airway irritation,
        // NOT thermoregulation. 32-50F is the performance optimum: zero penalty.
        let coldImpact = 0;
        if      (windChillF >= 32) coldImpact = 0;
        else if (windChillF >= 20) coldImpact = -0.5;
        else if (windChillF >= 10) coldImpact = -1.5;
        else if (windChillF >= 0)  coldImpact = -3;
        else                       coldImpact = -5;

        // ── WIND PENALTY (Pugh 1971, Davies 1980) ──
        // Drag scales with the square of wind speed. Anchored at 10mph headwind
        // = ~11 sec/mi. We don't know run direction, so assume a loop/out-and-back:
        // half the miles into it, and a tailwind only returns ~45% of what the
        // headwind took. Net = ~27.5% of the full headwind cost.
        const headwindSecPerMi = 0.11 * w * w;
        const windSecPerMi     = parseFloat((0.275 * headwindSecPerMi).toFixed(1));
        // Express as % against a nominal 7:30/mi so it composes with the temp scores
        const windImpact = -parseFloat(((windSecPerMi / 450) * 100).toFixed(1));

        perfImpact = perfImpact + coldImpact + windImpact;

        const heatRisk = tempC > 35 ? 'extreme' : tempC > 30 ? 'very high' : tempC > 25 ? 'high' : tempC > 20 ? 'moderate' : 'low';
        const coldRisk = windChillF <= 0 ? 'extreme' : windChillF <= 15 ? 'high' : windChillF <= 32 ? 'moderate' : 'low';
        const windRisk = (g >= 30 || w >= 25) ? 'extreme' : (g >= 22 || w >= 18) ? 'high' : w >= 12 ? 'moderate' : 'low';

        return {
          tempF:     Math.round(tempF),
          feelsF:    feelsF   != null ? Math.round(feelsF)   : null,
          humidity:  humidPct != null ? Math.round(humidPct) : null,
          windMph:   windMph  != null ? Math.round(windMph)  : null,
          gustMph:   gustMph  != null ? Math.round(gustMph)  : null,
          windChillF,
          tempC:     Math.round(tempC),
          perfImpact: parseFloat(perfImpact.toFixed(1)),
          windSecPerMi,
          heatRisk, coldRisk, windRisk,
        };
      } catch(e) {
        return null;
      }
    }

    // Fetch weather for last 10 runs in parallel
    const runsForWeather = runs.slice(0, 10);
    const weatherResults = await Promise.all(
      runsForWeather.map(r => {
        if (!r.start_latlng || r.start_latlng.length < 2) return Promise.resolve(null);
        const dateStr = r.start_date_local.split('T')[0];
        return getRunWeather(r.start_latlng[0], r.start_latlng[1], dateStr);
      })
    );

    // Build weather-enriched run summary
    const recentRunsSummary = runs.slice(0, 20).map((r, i) => {
      try {
        const wx = i < 10 ? weatherResults[i] : null;
        const secPerMi = r.average_speed > 0 ? 1609.34 / r.average_speed : null;
        const paceStr = secPerMi
          ? (() => {
              const m = Math.floor(secPerMi / 60);
              const s = Math.round(secPerMi % 60);
              return s === 60 ? `${m+1}:00/mi` : `${m}:${s.toString().padStart(2,'0')}/mi`;
            })()
          : null;
        return {
          date:     r.start_date_local.split('T')[0],
          miles:    (r.distance/1609.34).toFixed(2),
          pace:     paceStr,
          hr:       r.average_heartrate || null,
          name:     r.name,
          location: (r.start_latlng && r.start_latlng.length >= 2)
            ? `${r.start_latlng[0].toFixed(2)},${r.start_latlng[1].toFixed(2)}`
            : null,
          weather:  wx ? {
            tempF: wx.tempF, feelsF: wx.feelsF, humidity: wx.humidity,
            windMph: wx.windMph, gustMph: wx.gustMph, windChillF: wx.windChillF,
            perfImpact: wx.perfImpact, windSecPerMi: wx.windSecPerMi,
            heatRisk: wx.heatRisk, coldRisk: wx.coldRisk, windRisk: wx.windRisk,
          } : null,
        };
      } catch (e) {
        console.warn(`[analytics] skipped malformed run ${r?.id}:`, e.message);
        return null;
      }
    }).filter(Boolean);

    // Build weather context summary for Claude
    const runsWithWeather = recentRunsSummary.filter(r => r.weather);
    const hotRuns = runsWithWeather.filter(r => r.weather.tempF >= 85);
    const coldRuns  = runsWithWeather.filter(r => r.weather.windChillF <= 32);
    const windyRuns = runsWithWeather.filter(r => r.weather.windRisk === 'high' || r.weather.windRisk === 'extreme');
    const avgWind = runsWithWeather.length
      ? Math.round(runsWithWeather.reduce((s,r) => s + (r.weather.windMph||0), 0) / runsWithWeather.length)
      : null;
    const avgTempF = runsWithWeather.length
      ? Math.round(runsWithWeather.reduce((s,r) => s + r.weather.tempF, 0) / runsWithWeather.length)
      : null;
    const avgHumidity = runsWithWeather.length
      ? Math.round(runsWithWeather.reduce((s,r) => s + (r.weather.humidity||0), 0) / runsWithWeather.length)
      : null;
    const avgPerfImpact = runsWithWeather.length
      ? parseFloat((runsWithWeather.reduce((s,r) => s + r.weather.perfImpact, 0) / runsWithWeather.length).toFixed(1))
      : null;

    const weatherContext = runsWithWeather.length ? `
WEATHER CONDITIONS ACROSS RECENT RUNS (actual data per activity location):
- Runs analyzed with weather data: ${runsWithWeather.length}
- Average temperature: ${avgTempF}°F
- Average humidity: ${avgHumidity}%
- Average performance impact from conditions: ${avgPerfImpact}%
- Runs in heat (≥85°F): ${hotRuns.length} of ${runsWithWeather.length}
- Runs in cold (wind chill ≤32°F): ${coldRuns.length} of ${runsWithWeather.length}
- Runs in significant wind (≥18mph or gusting ≥22): ${windyRuns.length} of ${runsWithWeather.length}
- Average wind: ${avgWind}mph
- Per-run weather breakdown:
${runsWithWeather.slice(0,8).map(r =>
   `  ${r.date} | ${r.miles}mi @ ${r.pace || '?'} | ${r.weather.tempF}°F chill ${r.weather.windChillF}°F | ${r.weather.humidity}% humidity | wind ${r.weather.windMph}mph gust ${r.weather.gustMph} (${r.weather.windSecPerMi}s/mi) | impact: ${r.weather.perfImpact}% | heat: ${r.weather.heatRisk} cold: ${r.weather.coldRisk} wind: ${r.weather.windRisk}`
).join('\n')}

TEMPERATURE SCIENCE (El Helou 2012, Ely 2007; Pugh 1971, Davies 1980):
- Optimal marathon training: 45-54°F (7-12°C)
- Heat: -1.5% at 68°F, -4% at 77°F, -10% at 86°F, -17% at 95°F, -25% at 104°F
- Humidity ≥70% prevents sweat evaporation — compounds heat stress significantly
- Cold: 32-50°F is the performance optimum, NOT a penalty. Below freezing the cost is
  small (-0.5% to -3%) and comes from footing, clothing weight, and airway irritation
  rather than thermoregulation. Do not tell him cold weather is slowing him down when
  the wind chill is above freezing — it is not.
- Wind: drag scales with the SQUARE of wind speed. A 10mph headwind costs ~11 sec/mi;
  a tailwind returns only ~45% of that, so out-and-back routes always lose net time.
  windSecPerMi in the data is the already-netted loop estimate.
- Houston summers: 90-100°F with 70-85% humidity June-Sept requires 60-90 sec/mile slower
- Houston Marathon (Jan 17) risk is a north wind behind a cold front, not temperature
- Boulder altitude (~5,400 ft): additional ~3-5% performance reduction vs sea level

    // 9. ── AI INSIGHTS via Claude ──
    // AFTER — Gemini Flash, free, works now
    const coachPrompt = `You are a world-class running coach analyzing Yash Hooda's training data.
Yash's PRs: 5K 18:15, Half Marathon 1:24:31, 8K 29:48. Marathon goal: sub-3:00. Currently training for 2027 Chevron Houston Marathon (goal: sub 3 at sea level).
CTL (fitness): ${ctlRounded}, ATL (fatigue): ${atlRounded}, Form: ${form}
Pace zones (last 30 runs): ${JSON.stringify(paceZones)}
${weatherContext}
Recent 20 runs (with actual weather per location): ${JSON.stringify(recentRunsSummary)}

TEMPERATURE SCIENCE CONTEXT:
- Optimal marathon training temp: 7-12°C (45-54°F)
- Performance drops -2 to -5% at 20-25°C, -5 to -15% at 25-30°C, >-15% above 30°C
- High humidity (≥70%) prevents sweat evaporation — compounds heat stress significantly
- Houston summers require slowing easy runs 60-90 sec/mile vs goal pace
- Boulder altitude will slow pace ~3-5% vs sea level Houston training
- 80/20 rule: 80% easy (conversational), 20% quality — crucial in heat to avoid overtraining

Write 3 short sharp coaching insights (2-3 sentences each) about:
1. Current fitness trend and readiness — reference actual CTL/ATL/form numbers
2. Weather impact on training — be specific about the actual conditions from recent runs. Identify whether heat, cold, or wind is the dominant factor and what pace adjustments follow. Do not default to heat if the data shows otherwise.
3. One specific actionable recommendation for marathon prep considering both fitness data and current conditions

Be specific, data-driven, and honest. If conditions are brutal, say so clearly. No bullet points — flowing paragraphs separated by newlines.`;

    let insights = 'Unable to generate insights at this time.';
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 2000,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: coachPrompt }],
        }),
      });

      if (!claudeRes.ok) {
        const errBody = await claudeRes.text();
        console.error(`Claude insights ${claudeRes.status}:`, errBody.slice(0, 400));
      } else {
        const claudeData = await claudeRes.json();
        const insightText = (claudeData.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim();

        if (insightText) {
          insights = insightText;
        } else {
          console.error('Claude insights empty:', JSON.stringify(claudeData).slice(0, 300));
            }
      }
    } catch (e) {
      console.error('Claude insights fetch failed:', e.message);
    }

        const payload = {
          weeklyTrend,
          fitness: { ctl: ctlRounded, atl: atlRounded, form },
          paceZones,
          predictions,
          insights,
        };

        if (cacheRedis) {
          try { await cacheRedis.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL }); }
          catch (e) { console.error('[ANALYTICS] cache write failed:', e.message); }
        }

        res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
        res.setHeader('X-Cache', 'MISS');
        return res.status(200).json(payload);

   } catch (err) {
     console.error('Analytics error:', err);
     return res.status(500).json({ error: 'Internal server error' });
   }
 }
