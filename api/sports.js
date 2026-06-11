export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league } = req.query;
  const validLeagues = ['nba','mlb','mls','nfl','worldcup','rockets','astros','texans'];
  if (!league || !validLeagues.includes(league)) {
    return res.status(400).json({ error: `Invalid league. Use: ${validLeagues.join(', ')}` });
  }

  // Single master API key for all sports
  const apiKey = process.env.SPORTRADAR_API_KEY;

  const sportMap = {
    nba: 'nba', rockets: 'nba',
    mlb: 'mlb', astros:  'mlb',
    nfl: 'nfl', texans:  'nfl',
    mls: 'soccer', worldcup: 'soccer',
  };

  const houstonTeams = { rockets: 'hou', astros: 'hou', texans: 'hou' };
  const isHouston = !!houstonTeams[league];
  const sport = sportMap[league];

  // Get today's date in YYYY/MM/DD format for SportRadar
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');

  // Try SportRadar first if key exists, ESPN fallback otherwise
  if (apiKey) {
    try {
      let games = [];

      // ── NBA ──
      if (sport === 'nba') {
        const url = `https://api.sportradar.com/nba/trial/v8/en/games/${year}/${month}/${day}/schedule.json?api_key=${apiKey}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`NBA API ${r.status}: ${await r.text().then(t => t.slice(0,100))}`);
        const d = await r.json();

        games = await Promise.all((d.games || []).map(async g => {
          const home = g.home;
          const away = g.away;
          const isLive  = g.status === 'inprogress';
          const isFinal = g.status === 'closed';

          // Fetch boxscore for live/recent games
          let boxscore = null;
          if ((isLive || isFinal) && g.id) {
            try {
              const bs = await fetch(
                `https://api.sportradar.com/nba/trial/v8/en/games/${g.id}/boxscore.json?api_key=${apiKey}`,
                { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
              );
              if (bs.ok) boxscore = await bs.json();
            } catch(e) {}
          }

          const quarters = (g.home_points_by_period || []).map((pts, i) => ({
            period: i + 1,
            home: pts,
            away: (g.away_points_by_period || [])[i] ?? 0,
          }));

          const homeWinProb = g.home_team_win_probability != null
            ? parseFloat(g.home_team_win_probability) : null;

          let topPlayers = [];
          if (boxscore) {
            const all = [
              ...(boxscore.home?.players || []).map(p => ({ ...p, teamAlias: home.alias })),
              ...(boxscore.away?.players || []).map(p => ({ ...p, teamAlias: away.alias })),
            ];
            topPlayers = all
              .filter(p => (p.statistics?.points || 0) >= 5)
              .sort((a,b) => (b.statistics?.points||0) - (a.statistics?.points||0))
              .slice(0, 6)
              .map(p => ({
                name: p.full_name || p.last_name,
                team: p.teamAlias,
                pts:  p.statistics?.points || 0,
                reb:  p.statistics?.rebounds || 0,
                ast:  p.statistics?.assists || 0,
              }));
          }

          return {
            id: g.id,
            status: isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled',
            start_time:   g.scheduled,
            start_date_ms: new Date(g.scheduled).getTime(),
            local_start:  new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
            home: home.alias, away: away.alias,
            home_name: home.market + ' ' + home.name,
            away_name: away.market + ' ' + away.name,
            score: (g.home_points != null) ? { [home.alias]: g.home_points, [away.alias]: g.away_points } : undefined,
            quarters,
            win_probability: homeWinProb != null ? {
              [home.alias]: homeWinProb,
              [away.alias]: parseFloat((100 - homeWinProb).toFixed(1)),
            } : null,
            live_detail: isLive && g.quarter ? `Q${g.quarter}${g.clock ? ' · ' + g.clock : ''}` : null,
            top_players: topPlayers,
            venue: g.venue?.name || null,
            broadcast: g.broadcasts?.[0]?.network || null,
            title: g.title || null,
          };
        }));

        if (isHouston) {
          games = games.filter(g => g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou');
        }
      }

      // ── MLB ──
      else if (sport === 'mlb') {
        const url = `https://api.sportradar.com/mlb/trial/v7/en/games/${year}/${month}/${day}/schedule.json?api_key=${apiKey}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`MLB API ${r.status}: ${await r.text().then(t => t.slice(0,100))}`);
        const d = await r.json();

        games = await Promise.all((d.games || []).map(async g => {
          const home = g.home;
          const away = g.away;
          const isLive  = g.status === 'inprogress';
          const isFinal = g.status === 'closed';

          let boxscore = null;
          if ((isLive || isFinal) && g.id) {
            try {
              const bs = await fetch(
                `https://api.sportradar.com/mlb/trial/v7/en/games/${g.id}/boxscore.json?api_key=${apiKey}`,
                { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
              );
              if (bs.ok) boxscore = await bs.json();
            } catch(e) {}
          }

          const innings = (g.innings || []).map(inn => ({
            inning: inn.number,
            home: inn.home_runs ?? '-',
            away: inn.away_runs ?? '-',
          }));

          const situation = boxscore?.situation;
          let liveDetail = null;
          if (isLive && situation) {
            const tb = situation.inning_half === 'T' ? '▲' : '▼';
            liveDetail = `${tb}${situation.inning} · ${situation.outs || 0} out`;
          }

          let topPlayers = [];
          if (boxscore) {
            const batters = [
              ...(boxscore.home?.players || []).filter(p => p.statistics?.hitting).map(p => ({ ...p, teamAlias: home.abbr })),
              ...(boxscore.away?.players || []).filter(p => p.statistics?.hitting).map(p => ({ ...p, teamAlias: away.abbr })),
            ];
            topPlayers = batters
              .sort((a,b) => (b.statistics?.hitting?.onbase?.h||0) - (a.statistics?.hitting?.onbase?.h||0))
              .slice(0, 6)
              .map(p => ({
                name: p.preferred_name || p.last_name,
                team: p.teamAlias,
                h:   p.statistics?.hitting?.onbase?.h || 0,
                hr:  p.statistics?.hitting?.onbase?.hr || 0,
                rbi: p.statistics?.hitting?.rbi || 0,
              }));
          }

          return {
            id: g.id,
            status: isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled',
            start_time:   g.scheduled,
            start_date_ms: new Date(g.scheduled).getTime(),
            local_start:  new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
            home: home.abbr, away: away.abbr,
            home_name: (home.market || '') + ' ' + (home.name || home.abbr),
            away_name: (away.market || '') + ' ' + (away.name || away.abbr),
            score: (g.home_runs != null) ? { [home.abbr]: g.home_runs, [away.abbr]: g.away_runs } : undefined,
            innings,
            live_detail: liveDetail,
            top_players: topPlayers,
            venue: g.venue?.name || null,
            broadcast: g.broadcasts?.[0]?.network || null,
          };
        }));

        if (isHouston) {
          games = games.filter(g => g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou');
        }
      }

      // ── NFL ──
      else if (sport === 'nfl') {
        // Get current season schedule
        const url = `https://api.sportradar.com/nfl/official/trial/v7/en/games/${year}/REG/schedule.json?api_key=${apiKey}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`NFL API ${r.status}: ${await r.text().then(t => t.slice(0,100))}`);
        const d = await r.json();

        // Find current or most recent week
        const nowMs = now.getTime();
        const weeks = d.weeks || [];
        let currentWeek = weeks.find(w => {
          const games = w.games || [];
          if (!games.length) return false;
          const start = new Date(games[0].scheduled).getTime();
          const end   = new Date(games[games.length-1].scheduled).getTime() + 86400000;
          return nowMs >= start && nowMs <= end;
        });
        if (!currentWeek) currentWeek = weeks[weeks.length - 1];

        games = (currentWeek?.games || []).map(g => {
          const home = g.home;
          const away = g.away;
          const isLive  = g.status === 'inprogress';
          const isFinal = g.status === 'closed';

          const quarters = [1,2,3,4].map(q => ({
            period: q,
            home: home.scoring?.[`T${q}`] ?? '-',
            away: away.scoring?.[`T${q}`] ?? '-',
          }));

          return {
            id: g.id,
            status: isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled',
            start_time:   g.scheduled,
            start_date_ms: new Date(g.scheduled).getTime(),
            local_start:  new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
            home: home.alias, away: away.alias,
            home_name: home.name, away_name: away.name,
            score: (home.points != null) ? { [home.alias]: home.points, [away.alias]: away.points } : undefined,
            quarters,
            live_detail: isLive && g.quarter ? `Q${g.quarter}${g.clock ? ' · ' + g.clock : ''}` : null,
            venue: g.venue?.name || null,
            broadcast: g.broadcasts?.[0]?.network || null,
            title: currentWeek?.title || null,
          };
        });

        if (isHouston) {
          games = games.filter(g => g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou');
        }
      }

      // ── SOCCER (MLS + World Cup) ──
      else if (sport === 'soccer') {
        const compId = league === 'worldcup' ? 'sr:competition:17' : 'sr:competition:242';
        const url = `https://api.sportradar.com/soccer/trial/v4/en/schedules/${year}-${month}-${day}/schedule.json?api_key=${apiKey}`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`Soccer API ${r.status}: ${await r.text().then(t => t.slice(0,100))}`);
        const d = await r.json();

        const filtered = (d.sport_events || []).filter(e =>
          e.tournament?.unique_tournament?.id === compId ||
          e.tournament?.id === compId ||
          (league === 'worldcup' && e.tournament?.name?.toLowerCase().includes('world cup')) ||
          (league === 'mls' && e.tournament?.name?.toLowerCase().includes('mls'))
        );

        games = filtered.map(e => {
          const sts  = e.sport_event_status || {};
          const home = e.competitors?.find(c => c.qualifier === 'home');
          const away = e.competitors?.find(c => c.qualifier === 'away');
          const isLive  = sts.status === 'live';
          const isFinal = sts.status === 'closed';
          return {
            id: e.id,
            status: isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled',
            start_time:   e.start_time,
            start_date_ms: new Date(e.start_time).getTime(),
            local_start:  new Date(e.start_time).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
            home: home?.abbreviation || home?.name?.slice(0,3).toUpperCase() || 'HME',
            away: away?.abbreviation || away?.name?.slice(0,3).toUpperCase() || 'AWY',
            home_name: home?.name || 'Home',
            away_name: away?.name || 'Away',
            score: (sts.home_score != null) ? {
              [home?.abbreviation || 'HME']: sts.home_score,
              [away?.abbreviation || 'AWY']: sts.away_score,
            } : undefined,
            live_detail: isLive ? `${sts.match_status || ''} ${sts.clock?.played ? sts.clock.played + "'" : ''}`.trim() : null,
            title: e.tournament?.name || null,
            venue: e.venue?.name || null,
          };
        });
      }

      // Sort: live → recent → upcoming
      const live     = games.filter(g => g.status === 'inprogress');
      const recent   = games.filter(g => g.status === 'closed').sort((a,b) => b.start_date_ms - a.start_date_ms).slice(0, 6);
      const upcoming = games.filter(g => g.status === 'scheduled').sort((a,b) => a.start_date_ms - b.start_date_ms).slice(0, 6);

      // For Houston teams, show last 6 results + next 6 upcoming
      let sorted = isHouston
        ? [...live, ...recent, ...upcoming]
        : [...live, ...recent, ...upcoming];

      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({ league, games: sorted, total: sorted.length, source: 'sportradar' });

    } catch(err) {
      console.error(`SportRadar error (${league}):`, err.message);
      // Fall through to ESPN fallback below
    }
  }

  // ══════════════════════════════════════════════════════
  // ESPN FALLBACK (always works, basic data)
  // ══════════════════════════════════════════════════════
  try {
    const espnLeagueMap = {
      nba:'basketball/nba', mlb:'baseball/mlb', mls:'soccer/usa.1',
      nfl:'football/nfl', worldcup:'soccer/fifa.world',
      rockets:'basketball/nba', astros:'baseball/mlb', texans:'football/nfl',
    };
    const houstonTeams = { rockets:'hou', astros:'hou', texans:'hou' };
    const isHoustonTeam = !!houstonTeams[league];
    const espnUrl = isHoustonTeam
      ? `https://site.api.espn.com/apis/site/v2/sports/${espnLeagueMap[league]}/teams/${houstonTeams[league]}/schedule`
      : `https://site.api.espn.com/apis/site/v2/sports/${espnLeagueMap[league]}/scoreboard`;

    const r = await fetch(espnUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('ESPN fallback failed');
    const data = await r.json();
    const events = data.events || [];

    const parseScore = (val) => { const n = parseInt(val); return isNaN(n) ? undefined : n; };

    let games = events.map(event => {
      const comp = event.competitions?.[0];
      const competitors = comp?.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return null;

      const statusName  = event.status?.type?.name?.toLowerCase() || '';
      const statusState = event.status?.type?.state?.toLowerCase() || '';
      const isFinal = statusName.includes('final') || statusState === 'post';
      const isLive  = statusName.includes('progress') || statusState === 'in';
      const homeAbbr = home.team?.abbreviation || 'HOME';
      const awayAbbr = away.team?.abbreviation || 'AWAY';
      const score = {};
      const hScore = parseScore(home.score); if (hScore !== undefined) score[homeAbbr] = hScore;
      const aScore = parseScore(away.score); if (aScore !== undefined) score[awayAbbr] = aScore;

      // Line scores (quarters/halves)
      const homeLinescores = home.linescores || [];
      const awayLinescores = away.linescores || [];
      const quarters = homeLinescores.map((ls, i) => ({
        period: i + 1,
        home: ls.value ?? '-',
        away: awayLinescores[i]?.value ?? '-',
      }));

      // Live detail
      const period = event.status?.period;
      const clock  = event.status?.displayClock;
      const sportType = espnLeagueMap[league]?.split('/')[0];
      let liveDetail = null;
      if (isLive && period) {
        if (sportType === 'baseball') {
          const sit = comp?.situation;
          const tb = sit?.isTopInning !== undefined ? (sit.isTopInning ? '▲' : '▼') : '';
          liveDetail = `${tb}${period} · ${sit?.outs ?? 0} out`;
        } else if (sportType === 'basketball') {
          liveDetail = `Q${period}${clock ? ' · ' + clock : ''}`;
        } else if (sportType === 'football') {
          liveDetail = `Q${period}${clock ? ' · ' + clock : ''}`;
        } else if (sportType === 'soccer') {
          liveDetail = clock ? `${period === 2 ? '2nd' : '1st'} Half · ${clock}` : null;
        }
      }

      return {
        id: event.id,
        status: isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled',
        start_time: event.date,
        start_date_ms: new Date(event.date).getTime(),
        local_start: new Date(event.date).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
        home: homeAbbr, away: awayAbbr,
        home_name: home.team?.displayName || homeAbbr,
        away_name: away.team?.displayName || awayAbbr,
        score: Object.keys(score).length ? score : undefined,
        quarters: quarters.length ? quarters : undefined,
        live_detail: liveDetail,
        title: comp?.notes?.[0]?.headline || null,
        venue: comp?.venue?.fullName || null,
        broadcast: comp?.broadcasts?.[0]?.names?.[0] || null,
        _source: 'espn',
      };
    }).filter(Boolean);

    if (isHoustonTeam) {
      games = games.filter(g =>
        g.home?.toLowerCase() === houstonTeams[league] ||
        g.away?.toLowerCase() === houstonTeams[league]
      );
      games.sort((a,b) => a.start_date_ms - b.start_date_ms);
      const nowMs  = Date.now();
      const live2  = games.filter(g => g.status === 'inprogress');
      const past   = games.filter(g => g.start_date_ms < nowMs && g.status !== 'inprogress');
      const future = games.filter(g => g.start_date_ms >= nowMs && g.status !== 'inprogress');
      games = [...live2, ...past.slice(-6).reverse(), ...future.slice(0, 6)];
    } else {
      const live2    = games.filter(g => g.status === 'inprogress');
      const recent   = games.filter(g => g.status === 'closed').slice(-6);
      const upcoming = games.filter(g => g.status === 'scheduled').slice(0, 6);
      games = [...live2, ...recent, ...upcoming];
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ league, games, total: games.length, source: 'espn-fallback' });

  } catch(fallbackErr) {
    console.error('ESPN fallback failed:', fallbackErr.message);
    return res.status(500).json({ error: 'All sports data sources failed' });
  }
}
