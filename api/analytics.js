export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

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
    const { access_token } = await tokenRes.json();

    // 2. Fetch last 60 activities
    const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=60&page=1', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const activities = await actRes.json();

    // 3. Filter runs only
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
          `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,apparent_temperature` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
        const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        const d = await r.json();
        const temps     = d.hourly?.temperature_2m       || [];
        const humidity  = d.hourly?.relative_humidity_2m || [];
        const feelsLike = d.hourly?.apparent_temperature || [];
        const wind      = d.hourly?.wind_speed_10m       || [];
        const sliceArr  = (arr) => arr.slice(10, 14).filter(v => v !== null);
        const avg       = (arr) => arr.length ? arr.reduce((a,b) => a+b,0)/arr.length : null;
        const tempF    = avg(sliceArr(temps));
        const humidPct = avg(sliceArr(humidity));
        const feelsF   = avg(sliceArr(feelsLike));
        const windMph  = avg(sliceArr(wind));
        if (tempF === null) return null;
        const tempC = (tempF - 32) * 5/9;
        let perfImpact = 0;
        if      (tempC <= 10) perfImpact = 0;
        else if (tempC <= 15) perfImpact = 0;
        else if (tempC <= 20) perfImpact = -1.5;
        else if (tempC <= 25) perfImpact = -4;
        else if (tempC <= 30) perfImpact = -10;
        else if (tempC <= 35) perfImpact = -17;
        else                  perfImpact = -25;
        if (humidPct >= 70 && tempC > 20) perfImpact -= (humidPct - 70) * 0.1;
        const heatRisk = tempC > 35 ? 'extreme' : tempC > 30 ? 'very high' : tempC > 25 ? 'high' : tempC > 20 ? 'moderate' : 'low';
        return {
          tempF:     Math.round(tempF),
          feelsF:    feelsF   ? Math.round(feelsF)   : null,
          humidity:  humidPct ? Math.round(humidPct) : null,
          windMph:   windMph  ? Math.round(windMph)  : null,
          tempC:     Math.round(tempC),
          perfImpact: parseFloat(perfImpact.toFixed(1)),
          heatRisk,
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
        location: r.start_latlng ? `${r.start_latlng[0].toFixed(2)},${r.start_latlng[1].toFixed(2)}` : null,
        weather:  wx ? {
          tempF:      wx.tempF,
          feelsF:     wx.feelsF,
          humidity:   wx.humidity,
          windMph:    wx.windMph,
          perfImpact: wx.perfImpact,
          heatRisk:   wx.heatRisk,
        } : null,
      };
    });

    // Build weather context summary for Claude
    const runsWithWeather = recentRunsSummary.filter(r => r.weather);
    const hotRuns = runsWithWeather.filter(r => r.weather.tempF >= 85);
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
- Per-run weather breakdown:
${runsWithWeather.slice(0,8).map(r =>
  `  ${r.date} | ${r.miles}mi @ ${r.pace || '?'} | ${r.weather.tempF}°F feels ${r.weather.feelsF}°F | ${r.weather.humidity}% humidity | impact: ${r.weather.perfImpact}% | risk: ${r.weather.heatRisk}`
).join('\n')}

TEMPERATURE SCIENCE (El Helou 2012, Ely 2007):
- Optimal marathon training: 45-54°F (7-12°C)
- Performance drops -1.5% at 68°F, -4% at 77°F, -10% at 86°F, -17% at 95°F, -25% at 104°F
- Humidity ≥70% prevents sweat evaporation — compounds heat stress significantly
- Houston summers: 90-100°F with 70-85% humidity June-Sept requires 60-90 sec/mile slower on easy runs
- Boulder altitude (~5,400 ft): additional ~3-5% performance reduction vs sea level` : '';

    // 9. ── AI INSIGHTS via Claude ──
    // AFTER — Gemini Flash, free, works now
const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are a world-class running coach analyzing Yash Hooda's training data.
Yash's PRs: 5K 18:15, Half Marathon 1:24:31, 8K 29:48. Marathon goal: sub-3:00. Currently training for 2026 Boulderthon Marathon (Boulder, CO — altitude 5,400 ft).
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
2. Weather and heat impact on training — be specific about the actual conditions from recent runs and what pace adjustments are needed
3. One specific actionable recommendation for marathon prep considering both fitness data and current conditions

Be specific, data-driven, and honest. If conditions are brutal, say so clearly. No bullet points — flowing paragraphs separated by newlines.`
    }]
  }),
});
const openaiData = await openaiRes.json();
const insights = openaiData.choices?.[0]?.message?.content || 'Unable to generate insights at this time.';

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({
      weeklyTrend,
      fitness: { ctl: ctlRounded, atl: atlRounded, form },
      paceZones,
      predictions,
      insights,
    });

  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
