/* js/flight-log.js — real-aircraft logbook + lesson photos for #aviation (#journey).
   Everything on the page (stat tiles, logbook table, aircraft cards, gallery) renders from the
   three arrays below, so logging a flight is one new object in FLIGHTS.
   Source of truth is my LogTen logbook; times are hours in tenths. */
(function () {
  'use strict';

  // ✏️ Aircraft I've flown. `type` is the ICAO designator used in the logbook.
  var AIRCRAFT = {
    N1317E: {
      model: 'Cessna 172N Skyhawk II', year: 1978, type: 'C172',
      engine: 'Lycoming O-320 · 180 hp',
      panel: 'Analog six-pack · Garmin GNS 430',
      operator: 'Above & Beyond Aviation', base: 'KEDC'
    },
    N1710K: { fleet: 'atp' }, N94631: { fleet: 'atp' }, N25188: { fleet: 'atp' },
    N23134: { fleet: 'atp' }, N975TH: { fleet: 'atp' }
  };
  var FLEETS = {
    atp: {
      model: 'Cessna 172S Skyhawk SP', type: 'C172',
      engine: 'Lycoming IO-360-L2A · 180 hp, fuel injected',
      panel: 'Garmin G1000 glass cockpit',
      operator: 'ATP Flight School', base: 'KSGR'
    }
  };
  var AIRPORTS = {
    KSGR: 'Sugar Land Regional · Sugar Land, TX',
    KEDC: 'Austin Executive · Pflugerville, TX'
  };
  // ✏️ Current default training airport — shown as a stat tile and in the note.
  var HOME_AIRPORT = 'KSGR';

  // ✏️ One object per flight, newest first. `ldg: null` = not transcribed yet (shows as —).
  var FLIGHTS = [
    { date: '2026-11-13', tail: 'N1317E', from: 'KEDC', to: 'KEDC', total: 0.7, dual: 0.7, ldg: null, remarks: 'Discovery flight at Above & Beyond Aviation' },
    { date: '2026-08-18', tail: 'N975TH', from: 'KSGR', to: 'KSGR', total: 1.0, dual: 1.0, ldg: 1, remarks: 'Dual instruction' },
    { date: '2026-08-07', tail: 'N94631', from: 'KSGR', to: 'KSGR', total: 1.1, dual: 1.1, ldg: 3, remarks: 'Dual instruction' },
    { date: '2026-08-05', tail: 'N23134', from: 'KSGR', to: 'KSGR', total: 1.4, dual: 1.4, ldg: 1, remarks: 'Dual instruction' },
    { date: '2026-08-04', tail: 'N25188', from: 'KSGR', to: 'KSGR', total: 1.2, dual: 1.2, ldg: 1, remarks: 'Dual instruction' },
    { date: '2026-08-03', tail: 'N94631', from: 'KSGR', to: 'KSGR', total: 1.6, dual: 1.6, ldg: 1, remarks: 'Dual instruction' },
    { date: '2026-07-24', tail: 'N1710K', from: 'KSGR', to: 'KSGR', total: 1.0, dual: 1.0, ldg: null, remarks: 'Intro flight' }
  ];

  // ✏️ Lesson photos. Files live in /images/flight/ as <file>.jpg + <file>-thumb.jpg.
  var PHOTOS = [
    { file: '2026-11-13-n1317e-ramp', group: 'kedc', alt: 'Yash beside the red and white Cessna 172N N1317E on the ramp', caption: 'With N1317E before my discovery flight at Above & Beyond · KEDC, Nov 13 2026' },
    { file: '2026-11-13-n1317e-panel', group: 'kedc', alt: 'Analog instrument panel of Cessna 172N N1317E with a Garmin GNS 430', caption: 'N1317E — a 1978 Skyhawk II with a six-pack and a GNS 430' },
    { file: '2026-11-13-wing-strut', group: 'kedc', alt: 'View past the wing strut of a Cessna 172 over Central Texas farmland and ponds', caption: 'Under the wing over Central Texas' },
    { file: '2026-11-13-prop-cowl', group: 'kedc', alt: 'Propeller blades and red cowling against a layered overcast sky', caption: 'Over the nose, sun behind the overcast' },
    { file: '2026-11-13-sun-clouds', group: 'kedc', alt: 'Sun breaking through altocumulus clouds above flat farmland', caption: 'Sun breaking through an altocumulus deck' },
    { file: '2026-11-13-overcast', group: 'kedc', alt: 'Layered cloud deck with a highway running to the horizon', caption: 'Layered cloud deck east of Austin' },
    { file: '2026-07-24-n1710k-ramp', group: 'ksgr', alt: 'Yash standing next to Cessna 172S N1710K on the ramp at Sugar Land', caption: 'Intro flight in N1710K · KSGR, Jul 24 2026' },
    { file: '2026-08-18-n975th-g1000', group: 'ksgr', alt: 'Garmin G1000 primary flight display in Cessna 172S N975TH on the ramp', caption: 'N975TH on the ramp — G1000 up before taxi' },
    { file: '2026-08-g1000-cruise', group: 'ksgr', alt: 'Garmin G1000 showing 93 knots at 4,200 feet in cruise', caption: 'In the practice area: 4,200 ft, 93 KIAS' },
    { file: '2026-08-18-n975th-prop-clouds', group: 'ksgr', alt: 'Propeller arc against a layered cloud deck above the glareshield, with the G1000 out of focus below', caption: 'Prop arc and cloud layers from the left seat of N975TH' },
    { file: '2026-08-farmland-subdivision', group: 'ksgr', alt: 'View out the right window of a Cessna 172 over farmland and a new subdivision, with building cumulus on the horizon', caption: 'Farmland, a new subdivision and building cumulus southwest of Houston' },
    { file: '2026-08-18-n975th-descent', group: 'ksgr', alt: 'Garmin G1000 in N975TH showing 99 knots, 2,920 feet and a 650 fpm descent, heading 066 toward KSGR', caption: 'Heading home in N975TH: descending through 2,900 ft, KSGR Tower tuned' },
    { file: '2026-08-18-n975th-direct-ksgr', group: 'ksgr', alt: 'Garmin G1000 in N975TH showing direct-to KSGR, 11.4 nautical miles, bearing 063, at 2,900 feet', caption: 'Direct KSGR — 11.4 NM to go at 2,900 ft' },
    { file: '2026-08-houston-skyline', group: 'ksgr', alt: 'View over the cowling of a Cessna 172 of a river, a highway and the Houston skyline on the hazy horizon', caption: 'Inbound to Sugar Land with the Houston skyline on the horizon' },
    { file: '2026-08-ksgr-approach-fields', group: 'ksgr', alt: 'Low-altitude view of fields, a lake and neighborhoods stretching to the horizon under fair-weather cumulus', caption: 'Low over the fields and lakes on the way back into KSGR' },
    { file: '2026-08-ksgr-approach-lake', group: 'ksgr', alt: 'Banked view over a lakeside neighborhood and a winding creek, with the wheel fairing in the corner', caption: 'Banking over a lakeside neighborhood in the pattern' },
    { file: '2026-08-g1000-taxi', group: 'ksgr', alt: 'Garmin G1000 display while taxiing at Sugar Land Regional', caption: 'Taxiing at Sugar Land Regional' },
    { file: '2026-08-ksgr-sunset', group: 'ksgr', alt: 'Sunset behind hangars seen from under the wing of a Cessna 172', caption: 'Sunset on the KSGR ramp' }
  ];
  var VIDEO = {
    src: '/images/flight/2026-11-13-first-lesson.mp4',
    poster: '/images/flight/2026-11-13-first-lesson-poster.jpg',
    caption: 'Discovery flight out of KEDC in N1317E (20 s, no sound)'
  };
  var GROUPS = [
    { id: 'kedc', label: 'Above & Beyond Aviation · KEDC · Nov 2026' },
    { id: 'ksgr', label: 'ATP Flight School · KSGR · Summer 2026' }
  ];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0];
  }
  function hrs(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function acft(tail) {
    var a = AIRCRAFT[tail] || {};
    return a.fleet ? FLEETS[a.fleet] : a;
  }
  function sum(key) {
    return FLIGHTS.reduce(function (t, f) { return t + (f[key] || 0); }, 0);
  }
  function uniq(list) {
    return list.filter(function (v, i) { return list.indexOf(v) === i; });
  }
  function route(f) {
    return f.from === f.to
      ? '<span class="fl-apt" title="' + esc(AIRPORTS[f.from] || '') + '">' + esc(f.from) + '</span> <span class="fl-local">local</span>'
      : '<span class="fl-apt" title="' + esc(AIRPORTS[f.from] || '') + '">' + esc(f.from) + '</span> → ' +
        '<span class="fl-apt" title="' + esc(AIRPORTS[f.to] || '') + '">' + esc(f.to) + '</span>';
  }

  function renderStats() {
    var el = document.getElementById('fl-stats');
    if (!el) return;
    var tails = uniq(FLIGHTS.map(function (f) { return f.tail; }));
    var airports = uniq(FLIGHTS.reduce(function (a, f) { return a.concat([f.from, f.to]); }, []));
    var tiles = [
      [hrs(sum('total')), 'Total Hours'],
      [hrs(sum('dual')), 'Dual Received'],
      [String(FLIGHTS.length), 'Flights'],
      [String(sum('ldg')), 'Landings'],
      [String(tails.length), 'Airframes'],
      [String(airports.length), 'Airports'],
      [HOME_AIRPORT, 'Home Airport', AIRPORTS[HOME_AIRPORT]]
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="aviation-stat"' + (t[2] ? ' title="' + esc(t[2]) + '"' : '') +
        '><span class="aviation-stat-val">' + esc(t[0]) +
        '</span><div class="aviation-stat-label">' + esc(t[1]) + '</div></div>';
    }).join('');
    var note = document.getElementById('fl-note');
    if (note && FLIGHTS.length) {
      note.textContent = 'Weekend flying, logged for fun. Home airport: ' + HOME_AIRPORT +
        (AIRPORTS[HOME_AIRPORT] ? ' (' + AIRPORTS[HOME_AIRPORT].split(' · ')[0] + ')' : '') +
        '. Last flight ' + fmtDate(FLIGHTS[0].date) + '.';
    }
  }

  function renderTable() {
    var el = document.getElementById('fl-log');
    if (!el) return;
    var rows = FLIGHTS.map(function (f) {
      var a = acft(f.tail);
      return '<tr>' +
        '<td data-l="Date" class="fl-date">' + esc(fmtDate(f.date)) + '</td>' +
        '<td data-l="Aircraft"><span class="fl-tail">' + esc(f.tail) + '</span><span class="fl-model">' + esc(a.model || a.type || '') + '</span></td>' +
        '<td data-l="Route">' + route(f) + '</td>' +
        '<td data-l="Total" class="fl-num">' + hrs(f.total) + '</td>' +
        '<td data-l="Dual" class="fl-num">' + hrs(f.dual) + '</td>' +
        '<td data-l="Ldg" class="fl-num">' + (f.ldg == null ? '—' : esc(f.ldg)) + '</td>' +
        '<td data-l="Remarks" class="fl-rem">' + esc(f.remarks) + '</td>' +
        '</tr>';
    }).join('');
    el.innerHTML =
      '<table class="fl-table"><caption class="fl-sr">Flight log, newest first</caption>' +
      '<thead><tr><th scope="col">Date</th><th scope="col">Aircraft</th><th scope="col">Route</th>' +
      '<th scope="col" class="fl-num">Total</th><th scope="col" class="fl-num">Dual</th>' +
      '<th scope="col" class="fl-num">Ldg</th><th scope="col">Remarks</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><th scope="row" colspan="3">Totals · ' + FLIGHTS.length + ' flights</th>' +
      '<td data-l="Total" class="fl-num">' + hrs(sum('total')) + '</td><td data-l="Dual" class="fl-num">' + hrs(sum('dual')) + '</td>' +
      '<td data-l="Ldg" class="fl-num">' + sum('ldg') + '</td><td></td></tr></tfoot></table>';
  }

  function renderAircraft() {
    var el = document.getElementById('fl-aircraft');
    if (!el) return;
    // Group tails that share a spec (the ATP fleet) into one card.
    var cards = [], seen = {};
    FLIGHTS.forEach(function (f) {
      var a = AIRCRAFT[f.tail] || {};
      var key = a.fleet ? 'fleet:' + a.fleet : f.tail;
      if (!seen[key]) { seen[key] = { spec: acft(f.tail), tails: [], hours: 0, flights: 0 }; cards.push(seen[key]); }
      var c = seen[key];
      if (c.tails.indexOf(f.tail) < 0) c.tails.push(f.tail);
      c.hours += f.total; c.flights += 1;
    });
    el.innerHTML = cards.map(function (c) {
      var s = c.spec;
      return '<div class="fl-ac">' +
        '<div class="fl-ac-head"><span class="fl-ac-model">' + esc((s.year ? s.year + ' ' : '') + s.model) + '</span>' +
        '<span class="fl-ac-hrs">' + hrs(c.hours) + ' h · ' + c.flights + (c.flights === 1 ? ' flight' : ' flights') + '</span></div>' +
        '<dl class="fl-ac-specs">' +
        '<div><dt>Tail' + (c.tails.length > 1 ? 's' : '') + '</dt><dd>' + c.tails.map(esc).join(' · ') + '</dd></div>' +
        '<div><dt>Engine</dt><dd>' + esc(s.engine) + '</dd></div>' +
        '<div><dt>Panel</dt><dd>' + esc(s.panel) + '</dd></div>' +
        '<div><dt>Flown with</dt><dd>' + esc(s.operator) + ' · ' + esc(s.base) + '</dd></div>' +
        '</dl></div>';
    }).join('');
  }

  function renderGallery() {
    var el = document.getElementById('fl-gallery');
    if (!el) return;
    var html = '';
    GROUPS.forEach(function (g) {
      var items = PHOTOS.filter(function (p) { return p.group === g.id; });
      if (!items.length) return;
      html += '<div class="fl-group-label">' + esc(g.label) + '</div><div class="fl-grid">';
      if (g.id === 'kedc' && VIDEO) {
        html += '<figure class="fl-tile fl-video"><video controls muted playsinline preload="none" poster="' + esc(VIDEO.poster) + '">' +
          '<source src="' + esc(VIDEO.src) + '" type="video/mp4"></video><figcaption>' + esc(VIDEO.caption) + '</figcaption></figure>';
      }
      items.forEach(function (p) {
        var i = PHOTOS.indexOf(p);
        html += '<figure class="fl-tile"><button type="button" class="fl-photo" data-fl-idx="' + i + '" aria-label="Open photo: ' + esc(p.caption) + '">' +
          '<img loading="lazy" decoding="async" src="/images/flight/' + esc(p.file) + '-thumb.jpg" alt="' + esc(p.alt) + '"></button>' +
          '<figcaption>' + esc(p.caption) + '</figcaption></figure>';
      });
      html += '</div>';
    });
    el.innerHTML = html;

    // Reuse the site's existing photo lightbox (built for Strava activity photos).
    window.__stravaPhotos = window.__stravaPhotos || {};
    window.__stravaPhotos.__flightlog = PHOTOS.map(function (p) {
      return { url: '/images/flight/' + p.file + '.jpg', caption: p.caption };
    });
    el.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.fl-photo') : null;
      if (!btn) return;
      var idx = +btn.getAttribute('data-fl-idx');
      if (typeof window.openStravaLightbox === 'function') window.openStravaLightbox('__flightlog', idx);
      else window.open(window.__stravaPhotos.__flightlog[idx].url, '_blank', 'noopener');
    });
  }

  function init() {
    try { renderStats(); renderTable(); renderAircraft(); renderGallery(); }
    catch (err) { console.error('flight-log:', err); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
