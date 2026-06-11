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

  // ── API KEYS ──
  const keys = {
    nfl:    process.env.SPORTRADAR_NFL_KEY,
    nba:    process.env.SPORTRADAR_NBA_KEY,
    mlb:    process.env.SPORTRADAR_MLB_KEY,
    soccer: process.env.SPORTRADAR_SOCCER_KEY,
  };

  // ── Map league to SportRadar sport ──
  const sportMap = {
    nba:      'nba',
    rockets:  'nba',
    mlb:      'mlb',
    astros:   'mlb',
    nfl:      'nfl',
    texans:   'nfl',
    mls:      'soccer',
    worldcup: 'soccer',
  };

  const sport = sportMap[league];
  const apiKey = keys[sport];

  // ── Houston team IDs (SportRadar) ──
  const houstonIds = {
    rockets: 'sr:team:3412',   // Houston Rockets
    astros:  'sr:team:3633',   // Houston Astros
    texans:  'sr:team:4415',   // Houston Texans
  };

  const isHouston = !!houstonIds[league];

  try {
    let games = [];

    // ════════════════════════════════
    // NBA
    // ════════════════════════════════
    if (sport === 'nba') {
      const today = new Date().toISOString().split('T')[0];
      const url = `https://api.sportradar.com/nba/trial/v8/en/games/${today}/schedule.json?api_key=${apiKey}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`NBA API ${r.status}`);
      const d = await r.json();
      const rawGames = d.games || [];

      // For live games, fetch boxscore for each
      games = await Promise.all(rawGames.map(async g => {
        const isLive = g.status === 'inprogress';
        let boxscore = null;

        if (isLive && apiKey) {
          try {
            const bsRes = await fetch(
              `https://api.sportradar.com/nba/trial/v8/en/games/${g.id}/boxscore.json?api_key=${apiKey}`,
              { signal: AbortSignal.timeout(5000) }
            );
            if (bsRes.ok) boxscore = await bsRes.json();
          } catch(e) {}
        }

        const home = g.home;
        const away = g.away;
        const isFinal = g.status === 'closed';

        // Quarter scores
        const quarters = g.home_points_by_period?.map((pts, i) => ({
          period: i + 1,
          home: pts,
          away: g.away_points_by_period?.[i] || 0,
        })) || [];

        // Win probability
        const homeWinProb = g.home_team_win_probability
          ? parseFloat(g.home_team_win_probability)
          : null;

        // Top players from boxscore
        let topPlayers = [];
        if (boxscore?.home?.players || boxscore?.away?.players) {
          const allPlayers = [
            ...(boxscore.home?.players || []).map(p => ({ ...p, team: home.alias })),
            ...(boxscore.away?.players || []).map(p => ({ ...p, team: away.alias })),
          ];
          topPlayers = allPlayers
            .filter(p => p.statistics?.points >= 5)
            .sort((a,b) => (b.statistics?.points||0) - (a.statistics?.points||0))
            .slice(0, 6)
            .map(p => ({
              name:    p.full_name,
              team:    p.team,
              pts:     p.statistics?.points || 0,
              reb:     p.statistics?.rebounds || 0,
              ast:     p.statistics?.assists || 0,
              minutes: p.statistics?.minutes || null,
            }));
        }

        return {
          id:           g.id,
          status:       g.status,
          start_time:   g.scheduled,
          local_start:  new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
          home:         home.alias,
          away:         away.alias,
          home_name:    home.name,
          away_name:    away.name,
          home_logo:    `https://www.sportradar.com/media/img/teams/nba/${home.alias?.toLowerCase()}.png`,
          away_logo:    `https://www.sportradar.com/media/img/teams/nba/${away.alias?.toLowerCase()}.png`,
          score: (g.home_points !== undefined) ? {
            [home.alias]: g.home_points,
            [away.alias]: g.away_points,
          } : undefined,
          quarters,
          win_probability: homeWinProb ? {
            [home.alias]: homeWinProb,
            [away.alias]: parseFloat((100 - homeWinProb).toFixed(1)),
          } : null,
          live_detail:  isLive ? `Q${g.quarter} · ${g.clock}` : null,
          top_players:  topPlayers,
          venue:        g.venue?.name || null,
          broadcast:    g.broadcasts?.[0]?.network || null,
        };
      }));

      if (isHouston) {
        games = games.filter(g =>
          g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou'
        );
      }
    }

    // ════════════════════════════════
    // MLB
    // ════════════════════════════════
    else if (sport === 'mlb') {
      const today = new Date().toISOString().split('T')[0];
      const url = `https://api.sportradar.com/mlb/trial/v7/en/games/${today}/schedule.json?api_key=${apiKey}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`MLB API ${r.status}`);
      const d = await r.json();
      const rawGames = d.games || [];

      games = await Promise.all(rawGames.map(async g => {
        const isLive = g.status === 'inprogress';
        let boxscore = null;

        if (isLive && apiKey) {
          try {
            const bsRes = await fetch(
              `https://api.sportradar.com/mlb/trial/v7/en/games/${g.id}/boxscore.json?api_key=${apiKey}`,
              { signal: AbortSignal.timeout(5000) }
            );
            if (bsRes.ok) boxscore = await bsRes.json();
          } catch(e) {}
        }

        const home = g.home;
        const away = g.away;

        // Inning scores
        const innings = g.innings?.map(inn => ({
          inning: inn.number,
          home:   inn.home_runs ?? '-',
          away:   inn.away_runs ?? '-',
        })) || [];

        // Current inning/outs from boxscore
        const situation = boxscore?.situation;
        let liveDetail = null;
        if (isLive && situation) {
          const topBottom = situation.inning_half === 'T' ? '▲' : '▼';
          liveDetail = `${topBottom}${situation.inning} · ${situation.outs || 0} out`;
        }

        // Top performers
        let topPlayers = [];
        if (boxscore) {
          const homeBatters = boxscore.home?.players?.filter(p => p.statistics?.hitting) || [];
          const awayBatters = boxscore.away?.players?.filter(p => p.statistics?.hitting) || [];
          const allBatters = [
            ...homeBatters.map(p => ({ ...p, team: home.abbr })),
            ...awayBatters.map(p => ({ ...p, team: away.abbr })),
          ];
          topPlayers = allBatters
            .filter(p => p.statistics?.hitting?.onbase?.h >= 1)
            .sort((a,b) => (b.statistics?.hitting?.onbase?.h||0) - (a.statistics?.hitting?.onbase?.h||0))
            .slice(0, 6)
            .map(p => ({
              name: p.preferred_name || p.last_name,
              team: p.team,
              h:    p.statistics?.hitting?.onbase?.h || 0,
              hr:   p.statistics?.hitting?.onbase?.hr || 0,
              rbi:  p.statistics?.hitting?.rbi || 0,
              avg:  p.statistics?.hitting?.avg ? p.statistics.hitting.avg.toFixed(3) : null,
            }));
        }

        return {
          id:          g.id,
          status:      g.status === 'closed' ? 'closed' : g.status === 'inprogress' ? 'inprogress' : 'scheduled',
          start_time:  g.scheduled,
          local_start: new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
          home:        home.abbr,
          away:        away.abbr,
          home_name:   home.market + ' ' + home.name,
          away_name:   away.market + ' ' + away.name,
          score: (g.home_runs !== undefined) ? {
            [home.abbr]: g.home_runs,
            [away.abbr]: g.away_runs,
          } : undefined,
          innings,
          live_detail: liveDetail,
          top_players: topPlayers,
          venue:       g.venue?.name || null,
          broadcast:   g.broadcasts?.[0]?.network || null,
        };
      }));

      if (isHouston) {
        games = games.filter(g =>
          g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou'
        );
      }
    }

    // ════════════════════════════════
    // NFL
    // ════════════════════════════════
    else if (sport === 'nfl') {
      // Get current week schedule
      const url = `https://api.sportradar.com/nfl/official/trial/v7/en/games/2025/REG/schedule.json?api_key=${apiKey}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`NFL API ${r.status}`);
      const d = await r.json();

      // Find current/most recent week
      const now = new Date();
      const weeks = d.weeks || [];
      const currentWeek = weeks.find(w => {
        const start = new Date(w.games?.[0]?.scheduled);
        const end   = new Date(w.games?.[w.games.length-1]?.scheduled);
        return now >= start && now <= end;
      }) || weeks[weeks.length - 1];

      const rawGames = currentWeek?.games || [];

      games = await Promise.all(rawGames.map(async g => {
        const isLive = g.status === 'inprogress';
        let boxscore = null;

        if (isLive && apiKey) {
          try {
            const bsRes = await fetch(
              `https://api.sportradar.com/nfl/official/trial/v7/en/games/${g.id}/boxscore.json?api_key=${apiKey}`,
              { signal: AbortSignal.timeout(5000) }
            );
            if (bsRes.ok) boxscore = await bsRes.json();
          } catch(e) {}
        }

        const home = g.home;
        const away = g.away;

        // Quarter scores
        const quarters = home.scoring ? [1,2,3,4].map(q => ({
          period: q,
          home: home.scoring[`period_${q}`] ?? '-',
          away: away.scoring?.[`period_${q}`] ?? '-',
        })) : [];

        // Win probability
        const homeWinProb = g.situation?.home_team_win_pct
          ? parseFloat((g.situation.home_team_win_pct * 100).toFixed(1))
          : null;

        // Top players
        let topPlayers = [];
        if (boxscore) {
          const homePlayers = boxscore.home?.players || [];
          const awayPlayers = boxscore.away?.players || [];
          const allPlayers  = [
            ...homePlayers.map(p => ({ ...p, team: home.alias })),
            ...awayPlayers.map(p => ({ ...p, team: away.alias })),
          ];
          // Passers
          const passers = allPlayers
            .filter(p => p.statistics?.passing?.yards >= 50)
            .sort((a,b) => (b.statistics?.passing?.yards||0) - (a.statistics?.passing?.yards||0))
            .slice(0,2)
            .map(p => ({
              name: p.name,
              team: p.team,
              stat: `${p.statistics.passing.yards} yds, ${p.statistics.passing.touchdowns || 0} TD`,
              type: 'QB',
            }));
          // Rushers
          const rushers = allPlayers
            .filter(p => p.statistics?.rushing?.yards >= 20)
            .sort((a,b) => (b.statistics?.rushing?.yards||0) - (a.statistics?.rushing?.yards||0))
            .slice(0,2)
            .map(p => ({
              name: p.name,
              team: p.team,
              stat: `${p.statistics.rushing.yards} yds`,
              type: 'RB',
            }));
          topPlayers = [...passers, ...rushers];
        }

        const liveDetail = isLive && g.quarter && g.clock
          ? `Q${g.quarter} · ${g.clock}`
          : null;

        return {
          id:          g.id,
          status:      g.status === 'closed' ? 'closed' : g.status === 'inprogress' ? 'inprogress' : 'scheduled',
          start_time:  g.scheduled,
          local_start: new Date(g.scheduled).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
          home:        home.alias,
          away:        away.alias,
          home_name:   home.name,
          away_name:   away.name,
          score: (home.points !== undefined) ? {
            [home.alias]: home.points,
            [away.alias]: away.points,
          } : undefined,
          quarters,
          win_probability: homeWinProb ? {
            [home.alias]: homeWinProb,
            [away.alias]: parseFloat((100 - homeWinProb).toFixed(1)),
          } : null,
          live_detail: liveDetail,
          top_players: topPlayers,
          venue:       g.venue?.name || null,
          broadcast:   g.broadcasts?.[0]?.network || null,
          title:       currentWeek?.title || null,
        };
      }));

      if (isHouston) {
        games = games.filter(g =>
          g.home?.toLowerCase() === 'hou' || g.away?.toLowerCase() === 'hou'
        );
      }
    }

    // ════════════════════════════════
    // SOCCER (MLS + World Cup)
    // ════════════════════════════════
    else if (sport === 'soccer') {
      const competitionId = league === 'worldcup'
        ? 'sr:competition:17'   // FIFA World Cup
        : 'sr:competition:242'; // MLS

      const url = `https://api.sportradar.com/soccer/trial/v4/en/competitions/${competitionId}/schedules/live/schedules.json?api_key=${apiKey}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        // Fallback to today's schedule if no live games
        const today = new Date().toISOString().split('T')[0];
        const schedUrl = `https://api.sportradar.com/soccer/trial/v4/en/schedules/${today}/schedule.json?api_key=${apiKey}`;
        const sr = await fetch(schedUrl, { signal: AbortSignal.timeout(8000) });
        if (!sr.ok) throw new Error(`Soccer API ${sr.status}`);
        const sd = await sr.json();
        const rawGames = (sd.sport_events || []).filter(e =>
          league === 'worldcup'
            ? e.tournament?.id === 'sr:competition:17'
            : e.tournament?.id === 'sr:competition:242'
        );

        games = rawGames.map(e => ({
          id:          e.id,
          status:      e.sport_event_status?.status || 'scheduled',
          start_time:  e.start_time,
          local_start: new Date(e.start_time).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
          home:        e.competitors?.find(c => c.qualifier === 'home')?.abbreviation || 'HOME',
          away:        e.competitors?.find(c => c.qualifier === 'away')?.abbreviation || 'AWAY',
          home_name:   e.competitors?.find(c => c.qualifier === 'home')?.name || 'Home',
          away_name:   e.competitors?.find(c => c.qualifier === 'away')?.name || 'Away',
          score:       e.sport_event_status?.home_score !== undefined ? {
            [e.competitors?.find(c=>c.qualifier==='home')?.abbreviation]: e.sport_event_status.home_score,
            [e.competitors?.find(c=>c.qualifier==='away')?.abbreviation]: e.sport_event_status.away_score,
          } : undefined,
          live_detail: e.sport_event_status?.match_status || null,
          title:       e.tournament?.name || null,
          venue:       e.venue?.name || null,
        }));
      } else {
        const d = await r.json();
        games = (d.schedules || []).map(s => {
          const e   = s.sport_event;
          const sts = s.sport_event_status;
          const home = e.competitors?.find(c => c.qualifier === 'home');
          const away = e.competitors?.find(c => c.qualifier === 'away');
          return {
            id:          e.id,
            status:      sts?.status || 'scheduled',
            start_time:  e.start_time,
            local_start: new Date(e.start_time).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CDT',
            home:        home?.abbreviation || 'HOME',
            away:        away?.abbreviation || 'AWAY',
            home_name:   home?.name || 'Home',
            away_name:   away?.name || 'Away',
            score: sts?.home_score !== undefined ? {
              [home?.abbreviation]: sts.home_score,
              [away?.abbreviation]: sts.away_score,
            } : undefined,
            live_detail: sts?.match_status
              ? `${sts.match_status} ${sts.clock?.played || ''}'`
              : null,
            title:  e.tournament?.name || null,
            venue:  e.venue?.name || null,
          };
        });
      }
    }

    // ── Sort: live first, then recent, then upcoming ──
    const now = new Date();
    const live     = games.filter(g => g.status === 'inprogress');
    const recent   = games.filter(g => g.status === 'closed').slice(-6);
    const upcoming = games.filter(g => g.status === 'scheduled').slice(0, 6);
    const sorted   = [...live, ...recent, ...upcoming];

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({ league, games: sorted, total: sorted.length });

  } catch (err) {
    console.error(`Sports handler error (${league}):`, err);
    // Graceful fallback to ESPN if SportRadar fails
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

      const games = events.map(event => {
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
        const hScore = parseInt(home.score); if (!isNaN(hScore)) score[homeAbbr] = hScore;
        const aScore = parseInt(away.score); if (!isNaN(aScore)) score[awayAbbr] = aScore;
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
          live_detail: isLive ? event.status?.type?.shortDetail || null : null,
          title: comp?.notes?.[0]?.headline || null,
          teams: {
            [homeAbbr]: { name: home.team?.displayName || homeAbbr },
            [awayAbbr]: { name: away.team?.displayName || awayAbbr },
          },
          _fallback: true,
        };
      }).filter(Boolean);

      let filtered = isHoustonTeam
        ? games.filter(g => g.home?.toLowerCase() === houstonTeams[league] || g.away?.toLowerCase() === houstonTeams[league])
        : games;

      if (isHoustonTeam) {
        filtered.sort((a,b) => a.start_date_ms - b.start_date_ms);
        const nowMs = Date.now();
        const past   = filtered.filter(g => g.start_date_ms < nowMs && g.status !== 'inprogress');
        const live2  = filtered.filter(g => g.status === 'inprogress');
        const future = filtered.filter(g => g.start_date_ms >= nowMs && g.status !== 'inprogress');
        filtered = [...live2, ...past.slice(-6).reverse(), ...future.slice(0,6)];
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({ league, games: filtered, total: filtered.length, _source: 'espn-fallback' });
    } catch(fallbackErr) {
      console.error('ESPN fallback also failed:', fallbackErr);
      return res.status(500).json({ error: 'All sports data sources failed' });
    }
  }
}
