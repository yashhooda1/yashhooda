// lib/preflight.js — ES module. Deterministic preflight rules for /api/preflight-brief.
// ══════════════════════════════════════════════════════════════════════════════
// JS port of preflight/wx.py + preflight/rules.py from yashhooda1/metar-stream.
// Same thresholds, same flag codes, same verdict — keep the two in step.
// (The full multi-step tool-calling agent lives in metar-stream; the site runs
//  the rules + a deterministic nearby-TAF fill + one narrative call, which fits
//  a serverless time budget.)
//
// The verdict is decided HERE, never by the model.
// ══════════════════════════════════════════════════════════════════════════════

export const GO = 'GO', CAUTION = 'CAUTION', NO_GO = 'NO_GO';
const RANK = { GO: 0, CAUTION: 1, NO_GO: 2 };

export const STALE_METAR_MIN = 90;
const CURRENT_WINDOW_MS = 2 * 3600e3;
const TAF_WINDOW_MS = 3600e3;
export const SUBSTITUTE_TAF_MAX_NM = 50;

export const PROFILES = {
  vfr_conservative: { name: 'vfr_conservative', label: 'VFR — conservative personal mins', ceiling_ft: 3000, visibility_sm: 5, wind_kt: 15, gust_kt: 20, gust_spread_kt: 10, ifr: false, ceiling_margin_ft: 1000, visibility_margin_sm: 2, wind_margin_kt: 5 },
  vfr_standard:     { name: 'vfr_standard',     label: 'VFR — basic (1000 / 3)',           ceiling_ft: 1000, visibility_sm: 3, wind_kt: 20, gust_kt: 25, gust_spread_kt: 15, ifr: false, ceiling_margin_ft: 1500, visibility_margin_sm: 2, wind_margin_kt: 5 },
  ifr:              { name: 'ifr',              label: 'IFR — instrument rated',           ceiling_ft: 400,  visibility_sm: 1, wind_kt: 25, gust_kt: 30, gust_spread_kt: 15, ifr: true,  ceiling_margin_ft: 300,  visibility_margin_sm: 1, wind_margin_kt: 5 },
};

const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX', 'VV']);
const CLOUD_RE = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b/g;
const WX_TOKEN_RE = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*$/;
const NO_GO_WX = [['TS', 'thunderstorm'], ['FC', 'funnel cloud / tornado'], ['GR', 'hail'], ['FZRA', 'freezing rain'], ['FZDZ', 'freezing drizzle'], ['SS', 'sandstorm'], ['DS', 'duststorm']];
const CAUTION_WX = [['SN', 'snow'], ['FG', 'fog'], ['+RA', 'heavy rain'], ['BR', 'mist'], ['SH', 'showers']];

// ── parsing (mirrors preflight/wx.py) ───────────────────────────────────────
export function parseVisibility(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).trim().toUpperCase().replace('SM', '');
  if (!t) return null;
  if (t.endsWith('+') || t.startsWith('P')) {           // "6+" / "P6SM" = greater than → unrestricted
    const n = parseFloat(t.replace(/[P+]/g, ''));
    return Number.isFinite(n) ? Math.max(10, n) : null;
  }
  let total = 0;
  for (const part of t.split(/\s+/)) {
    if (part.includes('/')) {
      const [a, b] = part.split('/').map(Number);
      if (!Number.isFinite(a) || !b) return null;
      total += a / b;
    } else {
      const n = Number(part);
      if (!Number.isFinite(n)) return null;
      total += n;
    }
  }
  return total;
}

export function ceilingFromLayers(layers) {
  const bases = (layers || []).filter(l => l && CEILING_COVERS.has(String(l.cover || '').toUpperCase()) && typeof l.base === 'number').map(l => l.base);
  return bases.length ? Math.min(...bases) : null;
}

export function ceilingFromRaw(raw) {
  if (!raw) return null;
  const body = String(raw).split(' RMK ')[0];
  const bases = [...body.matchAll(CLOUD_RE)].filter(m => CEILING_COVERS.has(m[1])).map(m => Number(m[2]) * 100);
  return bases.length ? Math.min(...bases) : null;
}

export function flightCategory(cig, vis) {
  if (cig == null && vis == null) return 'UNKNOWN';
  const c = cig == null ? 99999 : cig, v = vis == null ? 99 : vis;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

export function hazards(wxString) {
  if (!wxString) return { noGo: [], caution: [] };
  const tokens = String(wxString).toUpperCase().split(' RMK ')[0].split(/\s+/).filter(t => t && WX_TOKEN_RE.test(t));
  const noGo = new Set(), caution = new Set();
  for (const tok of tokens) {
    if (tok.startsWith('VC')) { if (tok.includes('TS')) caution.add('thunderstorm in the vicinity'); continue; }
    const hard = NO_GO_WX.find(([c]) => tok.includes(c));
    if (hard) { noGo.add(`${hard[1]} (${tok})`); continue; }
    const soft = CAUTION_WX.find(([c]) => tok.includes(c));
    if (soft) caution.add(`${soft[1]} (${tok})`);
  }
  return { noGo: [...noGo].sort(), caution: [...caution].sort() };
}

export function toDate(v) {
  if (v == null) return null;
  const d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v) * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function distanceNm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(x => typeof x !== 'number')) return null;
  const r = 3440.065, rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// ── rules (mirrors preflight/rules.py) ──────────────────────────────────────
const worst = (...s) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), GO);
const catRank = c => ({ VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 })[c] ?? -1;
const flag = (severity, station, source, code, message) => ({ severity, station, source, code, message });

function checkConditions({ station, source, mins, ceiling, vis, wind, gust, wx, soften = false, label = '' }) {
  const out = [];
  const tag = label ? ` ${label}` : '';
  const add = (sev, code, msg) => out.push(flag(soften && sev === NO_GO ? CAUTION : sev, station, source, code, msg + tag));
  if (ceiling != null) {
    if (ceiling < mins.ceiling_ft) add(NO_GO, 'ceiling_below_min', `ceiling ${ceiling} ft < ${mins.ceiling_ft} ft minimum`);
    else if (ceiling < mins.ceiling_ft + mins.ceiling_margin_ft) add(CAUTION, 'ceiling_near_min', `ceiling ${ceiling} ft is close to the ${mins.ceiling_ft} ft minimum`);
  }
  if (vis != null) {
    if (vis < mins.visibility_sm) add(NO_GO, 'visibility_below_min', `visibility ${vis} sm < ${mins.visibility_sm} sm minimum`);
    else if (vis < mins.visibility_sm + mins.visibility_margin_sm) add(CAUTION, 'visibility_near_min', `visibility ${vis} sm is close to the ${mins.visibility_sm} sm minimum`);
  }
  if (wind != null) {
    if (wind > mins.wind_kt) add(NO_GO, 'wind_above_max', `wind ${wind} kt > ${mins.wind_kt} kt limit`);
    else if (wind > mins.wind_kt - mins.wind_margin_kt) add(CAUTION, 'wind_near_max', `wind ${wind} kt is close to the ${mins.wind_kt} kt limit`);
  }
  if (gust != null) {
    if (gust > mins.gust_kt) add(NO_GO, 'gust_above_max', `gusts ${gust} kt > ${mins.gust_kt} kt limit`);
    if (wind != null && gust - wind > mins.gust_spread_kt) add(CAUTION, 'gust_spread', `gust spread ${gust - wind} kt (> ${mins.gust_spread_kt} kt) — expect turbulence on final`);
  }
  const hz = hazards(wx);
  hz.noGo.forEach(h => add(NO_GO, 'hazardous_weather', h));
  hz.caution.forEach(h => add(CAUTION, 'weather_present', h));
  return out;
}

function evaluateMetar(station, m, mins, now, when) {
  if (!m) return { flags: [flag(CAUTION, station, 'DATA', 'no_metar', 'no current METAR — station may not report')], category: 'UNKNOWN' };
  const ceiling = ceilingFromLayers(m.clouds) ?? ceilingFromRaw(m.rawOb);
  const vis = parseVisibility(m.visib);
  const category = m.fltCat || flightCategory(ceiling, vis);
  const soften = Math.abs(when - now) > CURRENT_WINDOW_MS;
  const flags = checkConditions({
    station, source: 'METAR', mins, ceiling, vis, wind: m.wspd ?? null, gust: m.wgst ?? null,
    wx: m.wxString || m.rawOb, soften, label: soften ? '(current, trend only)' : '(current)',
  });
  const obs = toDate(m.obsTime);
  if (obs) {
    const age = (now - obs) / 60000;
    if (age > STALE_METAR_MIN) flags.push(flag(CAUTION, station, 'DATA', 'stale_metar', `latest METAR is ${Math.round(age)} min old`));
  }
  return { flags, category };
}

const zulu = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

function evaluateTaf(station, taf, mins, when, role, tafSource) {
  const start = when - TAF_WINDOW_MS, end = when.getTime() + TAF_WINDOW_MS;
  const periods = (taf?.fcsts || []).filter(p => {
    const a = toDate(p.timeFrom), b = toDate(p.timeTo);
    return a && b && a < end && b > start;
  });
  if (!periods.length) {
    const flags = role === 'enroute' ? [] : [flag(CAUTION, station, 'DATA', 'no_taf', 'no TAF covers this time — forecast unknown')];
    return { flags, worstCat: null };
  }
  const flags = [];
  let worstCat = null, alternate = false;
  for (const p of periods) {
    const change = String(p.fcstChange || 'BASE').toUpperCase();
    const prob = change === 'TEMPO' || change === 'PROB' || !!p.probability;
    const ceiling = ceilingFromLayers(p.clouds);
    const vis = parseVisibility(p.visib);
    const cat = flightCategory(ceiling, vis);
    if (catRank(cat) > catRank(worstCat)) worstCat = cat;
    const from = toDate(p.timeFrom);
    let label = `(TAF ${change} ${from ? zulu(from) : ''}`.trimEnd();
    if (tafSource && tafSource !== station) label += ` via ${tafSource}`;
    label += ')';
    flags.push(...checkConditions({ station, source: 'TAF', mins, ceiling, vis, wind: p.wspd ?? null, gust: p.wgst ?? null, wx: p.wxString, soften: prob, label }));
    if (mins.ifr && role === 'destination' && !prob && ((ceiling != null && ceiling < 2000) || (vis != null && vis < 3))) alternate = true;
  }
  if (alternate) flags.push(flag(CAUTION, station, 'TAF', 'alternate_required', '1-2-3 rule: file an alternate (ceiling < 2000 ft or vis < 3 sm within 1 hr of ETA)'));
  return { flags, worstCat };
}

function evaluateNotams(station, notams, mins) {
  if (notams == null) return [flag(CAUTION, station, 'NOTAM', 'notams_not_checked', 'NOTAMs not checked — pull them from an official source')];
  const out = [];
  for (const text of notams) {
    const u = text.toUpperCase();
    if (['AD AP CLSD', 'AERODROME CLOSED', 'AIRPORT CLOSED', 'AD CLSD'].some(k => u.includes(k))) out.push(flag(NO_GO, station, 'NOTAM', 'airport_closed', text.slice(0, 200)));
    else if (u.includes('RWY') && u.includes('CLSD')) out.push(flag(CAUTION, station, 'NOTAM', 'runway_closed', text.slice(0, 200)));
    else if (u.includes('TFR')) out.push(flag(CAUTION, station, 'NOTAM', 'tfr', text.slice(0, 200)));
    else if (mins.ifr && (u.includes('ILS') || u.includes('GPS')) && (u.includes('U/S') || u.includes('OTS'))) out.push(flag(CAUTION, station, 'NOTAM', 'approach_unavailable', text.slice(0, 200)));
  }
  return out;
}

/**
 * route: ['KAUS','KHOU']; data[icao] = { metar, taf, notams: string[]|null, lat, lon }
 * metar/taf are raw AWC JSON rows. tafSubstitutes: { KEDC: 'KAUS' }.
 */
export function briefRoute(route, data, { profile = 'vfr_conservative', etd, eteHours = 1, now = new Date(), tafSubstitutes = {} } = {}) {
  const mins = PROFILES[profile] || PROFILES.vfr_conservative;
  const dep = etd || now;
  const step = route.length > 1 ? eteHours / (route.length - 1) : 0;

  const stations = route.map((icao, i) => {
    const when = new Date(dep.getTime() + step * i * 3600e3);
    const role = route.length === 1 || i === 0 ? 'departure' : i === route.length - 1 ? 'destination' : 'enroute';
    const e = data[icao] || {};
    const m = evaluateMetar(icao, e.metar, mins, now, when);

    let taf = e.taf, tafSource = icao;
    const subFlags = [];
    const sub = tafSubstitutes[icao];
    if (!taf && sub) {
      const s = data[sub] || {};
      const d = distanceNm(e.lat, e.lon, s.lat, s.lon);
      if (s.taf && d != null && d <= SUBSTITUTE_TAF_MAX_NM) {
        taf = s.taf; tafSource = sub;
        subFlags.push(flag(CAUTION, icao, 'DATA', 'nearby_taf', `no TAF here — using ${sub} TAF (${Math.round(d)} nm away)`));
      } else {
        subFlags.push(flag(CAUTION, icao, 'DATA', 'substitute_rejected', `proposed TAF substitute ${sub} rejected (missing or > ${SUBSTITUTE_TAF_MAX_NM} nm)`));
      }
    }
    const t = evaluateTaf(icao, taf, mins, when, role, tafSource);
    const notamFlags = role === 'enroute' ? [] : evaluateNotams(icao, e.notams, mins);
    const flags = [...m.flags, ...subFlags, ...t.flags, ...notamFlags];
    return {
      station: icao, name: e.metar?.name || e.taf?.name || null, role, eval_time: when.toISOString().slice(0, 16) + 'Z',
      category_now: m.category, worst_forecast_category: t.worstCat,
      raw_metar: e.metar?.rawOb || null, raw_taf: taf?.rawTAF || null, taf_source: taf ? tafSource : null,
      notams_checked: e.notams != null, notam_count: Array.isArray(e.notams) ? e.notams.length : null,
      verdict: worst(...flags.map(f => f.severity)), flags,
    };
  });

  return {
    route, profile: mins, etd: dep.toISOString().slice(0, 16) + 'Z', ete_hours: eteHours,
    generated_at: now.toISOString(), verdict: worst(...stations.map(s => s.verdict)), stations,
    disclaimer: 'Not an official weather briefing. Obtain a standard briefing (1800wxbrief.com) and use your own judgement before flight.',
  };
}
