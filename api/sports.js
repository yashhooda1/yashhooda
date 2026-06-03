export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league } = req.query;

  const validLeagues = ['nba', 'mlb', 'mls', 'nfl', 'worldcup', 'rockets', 'astros', 'texans'];
  if (!league || !validLeagues.includes(league)) {
    return res.status(400).json({ error: `Invalid league. Use: ${validLeagues.join(', ')}` });
  }

  try {
    const espnLeagueMap = {
      nba:      'basketball/nba',
      mlb:      'baseball/mlb',
      mls:      'soccer/usa.1',
      nfl:      'football/nfl',
      worldcup: 'soccer/fifa.world',
      rockets:  'basketball/nba',
      astros:   'baseball/mlb',
      texans:   'football/nfl',
    };

    const houstonTeams = {
      rockets: 'hou',
      astros:  'hou',
      texans:  'hou',
    };

    const espnPath = espnLeagueMap[league];
    if (!espnPath) return res.status(400).json({ error: 'Invalid league' });

    const isHoustonTeam = !!houstonTeams[league];

    const espnUrl = isHoustonTeam
      ? `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/teams/${houstonTeams[league]}/schedule`
      : `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`;

    const response = await fetch(espnUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `ESPN API returned ${response.status}` });
    }

    const data = await response.json();
    const events = data.events || data.games || [];
    const now = new Date();

    const games = events.map(event => {
      const comp = event.competitions?.[0];
      const competitors = comp?.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return null;

      // STATUS — covers both scoreboard + schedule endpoint formats
      const statusName  = event.status?.type?.name?.toLowerCase() || '';
      const statusState = event.status?.type?.state?.toLowerCase() || '';
      const statusDesc  = event.status?.type?.description?.toLowerCase() || '';

      const isFinal = statusName.includes('final') || statusState === 'post' || statusDesc.includes('final');
      const isLive  = statusName.includes('progress') || statusState === 'in' || statusName.includes('in_progress');
      const gameStatus = isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled';

      // SCORE PARSING
      const parseScore = (val) => {
        if (val === undefined || val === null || val === '') return undefined;
        const n = parseInt(val);
        return isNaN(n) ? undefined : n;
      };

      const homeAbbr = home.team?.abbreviation || 'HOME';
      const awayAbbr = away.team?.abbreviation || 'AWAY';

      const score = {};
      const homeScoreParsed = parseScore(home.score);
      const awayScoreParsed = parseScore(away.score);
      if (homeScoreParsed !== undefined) score[homeAbbr] = homeScoreParsed;
      if (awayScoreParsed !== undefined) score[awayAbbr] = awayScoreParsed;

      // LIVE GAME PERIOD / INNING / CLOCK
      let liveDetail = null;
      if (isLive) {
        const period = event.status?.period;
        const clock  = event.status?.displayClock;
        const sport  = espnPath.split('/')[0];

        if (sport === 'baseball') {
          const inning    = period || '?';
          const situation = comp?.situation;
          const topBottom = situation?.isTopInning !== undefined
            ? (situation.isTopInning ? '▲' : '▼') : '';
          const outs = situation?.outs !== undefined ? ` · ${situation.outs} out` : '';
          liveDetail = `${topBottom}${inning}${outs}`;
        } else if (sport === 'basketball') {
          const qtr    = period || '?';
          const qLabel = qtr > 4 ? `OT${qtr - 4}` : `Q${qtr}`;
          liveDetail   = clock ? `${qLabel} · ${clock}` : qLabel;
        } else if (sport === 'football') {
          const qtr    = period || '?';
          const qLabel = qtr > 4 ? 'OT' : `Q${qtr}`;
          liveDetail   = clock ? `${qLabel} · ${clock}` : qLabel;
        } else if (sport === 'soccer') {
          const half = period === 2 ? '2nd Half' : '1st Half';
          liveDetail = clock ? `${half} · ${clock}` : half;
        }
      }

      // WIN PROBABILITY
      const winProb = {};
      if (home.statistics) {
        const homeWinProb = home.statistics?.find?.(s => s.name === 'winProbability')?.value;
        if (homeWinProb !== undefined) {
          winProb[homeAbbr] = parseFloat((homeWinProb * 100).toFixed(1));
          winProb[awayAbbr] = parseFloat(((1 - homeWinProb) * 100).toFixed(1));
        }
      }

      const startDate = new Date(event.date);
      const localStart = startDate.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago'
      }) + ' CDT';

      return {
        id:            event.id,
        status:        gameStatus,
        start_time:    event.date,
        start_date_ms: startDate.getTime(),
        local_start:   localStart,
        home:          homeAbbr,
        away:          awayAbbr,
        live_detail:   liveDetail,
        title:         comp?.notes?.[0]?.headline || event.name || null,
        teams: {
          [homeAbbr]: { name: home.team?.displayName || homeAbbr, abbreviation: homeAbbr },
          [awayAbbr]: { name: away.team?.displayName || awayAbbr, abbreviation: awayAbbr },
        },
        score:            Object.keys(score).length ? score : undefined,
        win_probability:  Object.keys(winProb).length ? winProb : undefined,
      };
    }).filter(Boolean);

    // HOUSTON TEAM: sort by date, show last 6 completed + next 6 upcoming
    let filteredGames = isHoustonTeam
      ? games.filter(g =>
          g.home?.toLowerCase() === houstonTeams[league] ||
          g.away?.toLowerCase() === houstonTeams[league]
        )
      : games;

    if (isHoustonTeam) {
      filteredGames.sort((a, b) => a.start_date_ms - b.start_date_ms);
      const nowMs   = now.getTime();
      const live    = filteredGames.filter(g => g.status === 'inprogress');
      const past    = filteredGames.filter(g => g.start_date_ms < nowMs && g.status !== 'inprogress');
      const future  = filteredGames.filter(g => g.start_date_ms >= nowMs && g.status !== 'inprogress');
      // Most recent 6 completed (reversed so newest shows first), next 6 upcoming
      filteredGames = [...live, ...past.slice(-6).reverse(), ...future.slice(0, 6)];
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ league, games: filteredGames, total: filteredGames.length });

  } catch (err) {
    console.error(`Sports handler error (${league}):`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
