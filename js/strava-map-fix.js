/**
 * strava-map-fix.js
 *
 * Fixes Leaflet maps not rendering on mobile.
 *
 * Root cause: Leaflet calculates map dimensions once at init time.
 * On mobile, the .strava-map divs are created dynamically (after the
 * Strava API responds), often while the section is off-screen or the
 * parent container hasn't painted yet — so Leaflet measures 0×0 and
 * renders a grey blank tile.
 *
 * Fix strategy (non-destructive, no original code modified):
 *  1. MutationObserver  — watches for .strava-map divs being added to the DOM,
 *                         then calls map.invalidateSize() after a 250ms delay.
 *  2. IntersectionObserver — calls invalidateSize() each time a map scrolls
 *                         into the viewport (handles lazy-scroll on mobile).
 *  3. orientationchange  — re-validates all maps when phone rotates.
 *  4. CSS injection      — ensures maps have an explicit height on every
 *                         screen size and fixes overflow/tile-layer issues.
 *
 * INSTALL: add ONE line to index.html just before </body>:
 *   <script src="js/strava-map-fix.js"></script>
 */

(function () {
  'use strict';

  // ── 1. CSS: guarantee map height & fix common mobile rendering issues ──
  const style = document.createElement('style');
  style.textContent = `
    /* Explicit sizing so Leaflet never measures 0×0 */
    .strava-map {
      height: 140px !important;
      min-height: 140px !important;
      width: 100% !important;
      display: block !important;
      position: relative !important;
    }

    /* On small screens give a bit more map height */
    @media (max-width: 480px) {
      .strava-map { height: 160px !important; min-height: 160px !important; }
    }

    /* Leaflet's internal container must fill the wrapper */
    .strava-map .leaflet-container {
      height: 100% !important;
      width: 100% !important;
      min-height: inherit !important;
    }

    /* Fix tile visibility on dark-mode mobile browsers */
    .strava-map .leaflet-tile-pane { opacity: 1 !important; }

    /* Prevent parent overflow:hidden clipping tiles on iOS Safari */
    .strava-card { overflow: visible !important; }
    .strava-map  { overflow: hidden !important; border-radius: 6px; }

    /* Fix touch-action so Leaflet drag works on mobile */
    .strava-map .leaflet-container {
      touch-action: pan-x pan-y !important;
    }
  `;
  document.head.appendChild(style);

  // ── 2. Core invalidation helper ──
  function invalidateMap(mapDiv) {
    if (!mapDiv) return;
    // Leaflet 1.x stores the map instance on the container element
    const map = mapDiv._leaflet_map;
    if (!map) return;
    try {
      map.invalidateSize({ animate: false, pan: false });
    } catch (e) {
      // non-fatal
    }
  }

  function invalidateAllMaps() {
    document.querySelectorAll('.strava-map').forEach(function (div) {
      invalidateMap(div);
    });
  }

  // ── 3. MutationObserver — catch maps added to the DOM dynamically ──
  function setupMutationObserver() {
    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return; // elements only

          // The added node itself might be a .strava-map
          if (node.classList && node.classList.contains('strava-map')) {
            scheduleInvalidate(node);
          }

          // Or it might contain .strava-map children (e.g. a whole card was added)
          const inner = node.querySelectorAll ? node.querySelectorAll('.strava-map') : [];
          inner.forEach(function (mapDiv) {
            scheduleInvalidate(mapDiv);
          });
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Multiple timeouts: Leaflet sometimes needs a second nudge
  function scheduleInvalidate(mapDiv) {
    [100, 300, 600, 1200].forEach(function (delay) {
      setTimeout(function () { invalidateMap(mapDiv); }, delay);
    });
    // Also set up IntersectionObserver for this specific map
    observeVisibility(mapDiv);
  }

  // ── 4. IntersectionObserver — invalidate when a map scrolls into view ──
  var visibilityObserver = null;

  function setupIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return; // old browsers fallback

    visibilityObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          invalidateMap(entry.target);
          // A second hit after the animation settles
          setTimeout(function () { invalidateMap(entry.target); }, 300);
        }
      });
    }, {
      rootMargin: '0px',
      threshold: 0.1, // trigger when 10% of the map is visible
    });

    // Attach to already-existing maps (page load case)
    document.querySelectorAll('.strava-map').forEach(function (div) {
      visibilityObserver.observe(div);
    });
  }

  function observeVisibility(mapDiv) {
    if (visibilityObserver) {
      visibilityObserver.observe(mapDiv);
    }
  }

  // ── 5. Handle device orientation change (phone rotation) ──
  window.addEventListener('orientationchange', function () {
    setTimeout(invalidateAllMaps, 300);
    setTimeout(invalidateAllMaps, 700);
  });

  // Also handle generic resize (covers browser zoom / desktop resize)
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(invalidateAllMaps, 250);
  });

  // ── 6. Page-visibility change (returning from another tab on mobile) ──
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      setTimeout(invalidateAllMaps, 300);
    }
  });

  // ── 7. Boot ──
  function boot() {
    setupMutationObserver();
    setupIntersectionObserver();
    // Hit any maps that already exist on page load
    setTimeout(invalidateAllMaps, 500);
    setTimeout(invalidateAllMaps, 1500); // second pass for slow connections
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  console.log('[strava-map-fix] loaded');
})();
