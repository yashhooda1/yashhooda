export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { league } = req.query;

  // ── FIXED: validLeagues now includes all tabs ──
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

    // Houston team filters
    const houstonTeams = {
      rockets: 'hou',
      astros:  'hou',
      texans:  'hou',
    };

    const espnPath = espnLeagueMap[league];
    if (!espnPath) return res.status(400).json({ error: 'Invalid league' });

    const isHoustonTeam = !!houstonTeams[league];

    // Houston teams use the schedule endpoint to get past + future games
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

    // Houston schedule endpoint returns { events: [] }, scoreboard returns { events: [] }
    const events = data.events || data.games || [];

    const games = events.map(event => {
      const comp = event.competitions?.[0];
      const competitors = comp?.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return null;

      const status = event.status?.type?.name?.toLowerCase() || 'scheduled';
      const isFinal = status === 'status_final' || status.includes('final');
      const isLive = status === 'status_in_progress' || status.includes('progress');

      const homeAbbr = home.team?.abbreviation || 'HOME';
      const awayAbbr = away.team?.abbreviation || 'AWAY';

      const gameStatus = isFinal ? 'closed' : isLive ? 'inprogress' : 'scheduled';

      const score = {};
      if (home.score !== undefined) score[homeAbbr] = parseInt(home.score);
      if (away.score !== undefined) score[awayAbbr] = parseInt(away.score);

      // Win probability
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
        id: event.id,
        status: gameStatus,
        start_time: event.date,
        local_start: localStart,
        home: homeAbbr,
        away: awayAbbr,
        title: comp?.notes?.[0]?.headline || event.name || null,
        teams: {
          [homeAbbr]: { name: home.team?.displayName || homeAbbr, abbreviation: homeAbbr },
          [awayAbbr]: { name: away.team?.displayName || awayAbbr, abbreviation: awayAbbr },
        },
        score: Object.keys(score).length ? score : undefined,
        win_probability: Object.keys(winProb).length ? winProb : undefined,
      };
    }).filter(Boolean);

    // For Houston teams filter to only their games
    const filteredGames = isHoustonTeam
      ? games.filter(g =>
          g.home?.toLowerCase() === houstonTeams[league] ||
          g.away?.toLowerCase() === houstonTeams[league]
        )
      : games;

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ league, games: filteredGames, total: filteredGames.length });

  } catch (err) {
    console.error(`Sports handler error (${league}):`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
