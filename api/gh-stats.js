// api/gh-stats.js
// Self-hosted GitHub README cards — stats, top languages, activity graph.
// Renders SVG directly so the profile README has no third-party dependency.
//
//   /api/gh-stats?card=stats
//   /api/gh-stats?card=langs
//   /api/gh-stats?card=graph
//
// Public endpoint (GitHub's camo proxy fetches it unauthenticated), so it is
// locked to an allowlisted login — otherwise it's an open proxy burning our
// GitHub token on strangers' profiles.
 
import { notifyFailure } from './_notify.js';
 
export const maxDuration = 30;
export const config = { runtime: 'nodejs' };
 
const ALLOWED_LOGINS = ['yashhooda1'];
const DEFAULT_LOGIN  = 'yashhooda1';
const CACHE_SECONDS  = 6 * 60 * 60;   // 6h — matches the Cache-Control we send
 
// yashhooda.ai palette
const THEME = {
  bg:     '#0d1117',
  accent: '#4caf50',
  text:   '#c9d1d9',
  muted:  '#8b949e',
  border: '#1f2933',
};
 
// ── UPSTASH (optional — degrades to no caching if unset) ─────────────────────
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
 
async function cacheGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
 
async function cacheSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}?EX=${CACHE_SECONDS}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(2500),
    });
  } catch { /* cache is best effort */ }
}
 
// ── GITHUB GRAPHQL ───────────────────────────────────────────────────────────
async function gql(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
 
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'yashhooda-gh-stats',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
 
  const d = await r.json();
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  if (d.errors?.length) throw new Error(d.errors[0].message);
  return d.data;
}
 
// Lifetime commits need one contributionsCollection per year — GitHub caps each
// window at 12 months. Aliasing them into a single query keeps it to one request
// instead of the Search API, which is what rate-limits the public instances.
async function fetchStats(login) {
  const seed = await gql(
    `query($login:String!){ user(login:$login){ createdAt } }`, { login }
  );
  const startYear = new Date(seed.user.createdAt).getUTCFullYear();
  const nowYear   = new Date().getUTCFullYear();
 
  const years = [];
  for (let y = startYear; y <= nowYear; y++) years.push(y);
 
  const yearFields = years.map(y =>
    `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z"){
       totalCommitContributions
       restrictedContributionsCount
     }`
  ).join('\n');
 
  const data = await gql(`
    query($login:String!){
      user(login:$login){
        name
        login
        followers { totalCount }
        pullRequests { totalCount }
        openIssues: issues(states:OPEN) { totalCount }
        closedIssues: issues(states:CLOSED) { totalCount }
        repositoriesContributedTo(contributionTypes:[COMMIT,PULL_REQUEST,ISSUE,REPOSITORY]) { totalCount }
        repositories(first:100, ownerAffiliations:OWNER, isFork:false,
                     orderBy:{field:STARGAZERS, direction:DESC}) {
          totalCount
          nodes { stargazerCount }
        }
        contributionsCollection { totalPullRequestReviewContributions }
        ${yearFields}
      }
    }
  `, { login });
 
  const u = data.user;
  // restrictedContributionsCount is the private-repo commit count. It only comes
  // back because this is our own token — it is the thing count_private=true
  // could never deliver on a shared public instance.
  const commits = years.reduce((s, y) => {
    const c = u[`y${y}`] || {};
    return s + (c.totalCommitContributions || 0) + (c.restrictedContributionsCount || 0);
  }, 0);
 
  return {
    name:    u.name || u.login,
    stars:   (u.repositories.nodes || []).reduce((s, n) => s + (n.stargazerCount || 0), 0),
    commits,
    prs:     u.pullRequests.totalCount,
    issues:  u.openIssues.totalCount + u.closedIssues.totalCount,
    reviews: u.contributionsCollection.totalPullRequestReviewContributions,
    repos:   u.repositories.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount,
    followers: u.followers.totalCount,
    since:   startYear,
  };
}
 
async function fetchLangs(login, count) {
  const data = await gql(`
    query($login:String!){
      user(login:$login){
        repositories(first:100, ownerAffiliations:OWNER, isFork:false){
          nodes {
            languages(first:10, orderBy:{field:SIZE, direction:DESC}){
              edges { size node { name color } }
            }
          }
        }
      }
    }
  `, { login });
 
  const totals = new Map();
  for (const repo of data.user.repositories.nodes || []) {
    for (const e of repo.languages?.edges || []) {
      const k = e.node.name;
      const prev = totals.get(k) || { size: 0, color: e.node.color || THEME.accent };
      prev.size += e.size;
      totals.set(k, prev);
    }
  }
 
  const all = [...totals.entries()]
    .map(([name, v]) => ({ name, size: v.size, color: v.color }))
    .sort((a, b) => b.size - a.size);
 
  const grand = all.reduce((s, l) => s + l.size, 0) || 1;
  return all.slice(0, count).map(l => ({ ...l, pct: (l.size / grand) * 100 }));
}
 
async function fetchGraph(login, days) {
  const to   = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  const data = await gql(`
    query($login:String!, $from:DateTime!, $to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from, to:$to){
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }
  `, { login, from: from.toISOString(), to: to.toISOString() });
 
  const out = [];
  for (const w of data.user.contributionsCollection.contributionCalendar.weeks) {
    for (const d of w.contributionDays) out.push({ date: d.date, count: d.contributionCount });
  }
  return out.slice(-days);
}
 
// ── SVG HELPERS ──────────────────────────────────────────────────────────────
// Everything user-controlled goes through this. Camo will happily serve broken
// XML, so an unescaped ampersand in a repo language name is a real outage.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
 
function nfmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
 
const FONT = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace";
 
function frame(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <rect width="${w}" height="${h}" rx="8" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="22" y="30" font-family="${FONT}" font-size="15" font-weight="700" fill="${THEME.accent}">${esc(title)}</text>
  ${body}
</svg>`;
}
 
function renderStats(s) {
  const rows = [
    ['Total commits',   nfmt(s.commits) + `  (${s.since}\u2013now)`],
    ['Stars earned',    nfmt(s.stars)],
    ['Pull requests',   nfmt(s.prs)],
    ['Issues',          nfmt(s.issues)],
    ['Code reviews',    nfmt(s.reviews)],
    ['Public repos',    nfmt(s.repos)],
    ['Contributed to',  nfmt(s.contributedTo)],
    ['Followers',       nfmt(s.followers)],
  ];
  const body = rows.map((r, i) => {
    const y = 62 + i * 24;
    return `<text x="22" y="${y}" font-family="${FONT}" font-size="12.5" fill="${THEME.muted}">${esc(r[0])}</text>
  <text x="428" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-weight="700" fill="${THEME.text}">${esc(r[1])}</text>
  <line x1="22" y1="${y + 7}" x2="428" y2="${y + 7}" stroke="${THEME.border}" stroke-width="1"/>`;
  }).join('\n  ');
 
  return frame(450, 270, `${s.name} \u2014 git log --stat`, body +
    `\n  <text x="22" y="256" font-family="${FONT}" font-size="10" fill="${THEME.muted}">private commits included \u00b7 served by yashhooda.ai</text>`);
}
 
function renderLangs(langs) {
  const W = 340, barW = 296, barX = 22, barY = 48;
  let x = barX;
  const segs = langs.map((l, i) => {
    const w = Math.max(2, (l.pct / 100) * barW);
    const r = `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="10" fill="${esc(l.color)}"${i === 0 ? ' rx="5"' : ''}/>`;
    x += w;
    return r;
  }).join('\n  ');
 
  const list = langs.map((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 22 + col * 158, ly = 84 + row * 22;
    return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${esc(l.color)}"/>
  <text x="${lx + 16}" y="${ly}" font-family="${FONT}" font-size="11.5" fill="${THEME.text}">${esc(l.name)} <tspan fill="${THEME.muted}">${l.pct.toFixed(1)}%</tspan></text>`;
  }).join('\n  ');
 
  const h = 84 + Math.ceil(langs.length / 2) * 22 + 14;
  return frame(W, h, 'Most used languages', segs + '\n  ' + list);
}
 
function renderGraph(days) {
  const W = 820, H = 220, padL = 44, padR = 20, padT = 48, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...days.map(d => d.count));
  const stepX = days.length > 1 ? plotW / (days.length - 1) : 0;
 
  const pts = days.map((d, i) => ({
    x: padL + i * stepX,
    y: padT + plotH - (d.count / max) * plotH,
    d,
  }));
 
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${(padL + plotW).toFixed(1)},${padT + plotH} L${padL},${padT + plotH} Z`;
 
  const gridVals = [0, Math.round(max / 2), max];
  const grid = gridVals.map(v => {
    const y = padT + plotH - (v / max) * plotH;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${THEME.border}"/>
  <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${THEME.muted}">${v}</text>`;
  }).join('\n  ');
 
  // Only label a handful of dates or they collide.
  const every = Math.ceil(days.length / 6);
  const labels = pts.map((p, i) => {
    if (i % every !== 0 && i !== pts.length - 1) return '';
    const [, m, d] = p.d.date.split('-');
    return `<text x="${p.x.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${THEME.muted}">${m}/${d}</text>`;
  }).filter(Boolean).join('\n  ');
 
  const dots = pts.map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#ffffff"/>`
  ).join('\n  ');
 
  const total = days.reduce((s, d) => s + d.count, 0);
 
  return frame(W, H,
    `Contribution activity \u2014 last ${days.length} days (${total} total)`,
    `<defs>
    <linearGradient id="wash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${THEME.accent}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${THEME.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${grid}
  <path d="${area}" fill="url(#wash)"/>
  <path d="${line}" fill="none" stroke="${THEME.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${labels}`);
}
 
function renderError(msg) {
  return frame(450, 90, 'Stats unavailable',
    `<text x="22" y="58" font-family="${FONT}" font-size="12" fill="${THEME.muted}">${esc(msg)}</text>`);
}
 
// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const card  = String(req.query.card || 'stats').toLowerCase();
  const login = String(req.query.username || DEFAULT_LOGIN);
  const count = Math.min(12, Math.max(1, parseInt(req.query.langs_count, 10) || 8));
  const days  = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 31));
 
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  // camo caches aggressively; this is what tells it when to come back.
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`);
 
  if (!ALLOWED_LOGINS.includes(login)) {
    return res.status(200).send(renderError('This endpoint only serves ' + DEFAULT_LOGIN + '.'));
  }
 
  const key = `ghcard:${card}:${login}:${count}:${days}`;
 
  try {
    const hit = await cacheGet(key);
    if (hit) return res.status(200).send(hit.svg);
 
    let svg;
    if (card === 'langs')      svg = renderLangs(await fetchLangs(login, count));
    else if (card === 'graph') svg = renderGraph(await fetchGraph(login, days));
    else                       svg = renderStats(await fetchStats(login));
 
    await cacheSet(key, { svg });
    return res.status(200).send(svg);
 
  } catch (err) {
    console.error('[GH-STATS]', card, err);
    await notifyFailure({ route: '/api/gh-stats', error: err, userMessage: card });
 
    // Serve the last good card if we have one rather than showing a broken image.
    const stale = await cacheGet(key);
    if (stale) return res.status(200).send(stale.svg);
 
    // Short cache on the error so a transient failure doesn't stick for 6 hours.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(renderError(err.message.slice(0, 60)));
  }
}
