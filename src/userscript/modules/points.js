// filepath: src/userscript/modules/points.js
// Points sync module: mirrors legacy CircleMarker click hooking and remote replay.
// Exports initPoints({ emit: { pointClicked } }) returning { onRemotePoint(p), onStateInit(st) }.

export function initPoints(deps = {}) {
  const emit = Object.assign({ pointClicked: (_p)=>{} }, (deps && deps.emit) || {});

  const log = (...a) => { try { console.log('[points]', ...a); } catch (_) {} };
  const vlog = (...a) => { try { if (typeof window !== 'undefined' && window.__squadPointsVerbose) console.log('[points]', ...a); } catch (_) {} };
  let __replayInProgress = false;
  let __lastReplaySig = null;

  // Fixed-cadence timing (ms)
  const FIXED_PRE_DELAY_MS = 200;   // wait before attempting the click
  const FIXED_POST_DELAY_MS = 20;  // wait after firing so next marker can appear
  const FIXED_ATTEMPTS = 1;         // bounded attempts within the time slot
  const FIXED_ATTEMPT_SPACING_MS = 20;

  // Remote click queue to serialize incoming points and keep timing consistent
  const __incomingQueue = [];
  let __queueProcessing = false;
  let __replayReadyOnce = null;

  function ensureReplayReadyOnce(maxWaitMs = 7000) {
    try {
      if (!__replayReadyOnce) __replayReadyOnce = waitForReplayReadiness([], maxWaitMs);
      return __replayReadyOnce;
    } catch (_) { return Promise.resolve(); }
  }

  async function __processIncomingQueue() {
    if (__queueProcessing) return;
    __queueProcessing = true;
    try {
      // Ensure hooks and at least one clickable target present before we begin
      await ensureReplayReadyOnce(7000);
      while (__incomingQueue.length) {
        // If a batch replay is running, wait to avoid interleaving
        while (__replayInProgress) { await new Promise(r => setTimeout(r, 40)); }
        const ll = __incomingQueue.shift();
        try { await clickWithFixedCadence(ll); } catch (_) {}
      }
    } catch (_) {}
    finally { __queueProcessing = false; }
  }

  function clicksSignature(clicks, path) {
    try {
      const n = Array.isArray(clicks) ? clicks.length : 0;
      if (!n) return `0@${path || ''}`;
      const last = clicks[n - 1] || {};
      const lat = (last.lat != null ? Number(last.lat).toFixed(6) : 'x');
      const lng = (last.lng != null ? Number(last.lng).toFixed(6) : 'x');
      return `${n}:${lat},${lng}@${path || ''}`;
    } catch (_) { return `err@${path || ''}`; }
  }

  function hookClickableMarker(marker) {
    try {
      if (!marker || !marker._events || !marker._events.click) return;
      const arr = marker._events.click;
      if (!Array.isArray(arr) || !arr.length || !arr[0] || typeof arr[0].fn !== 'function') return;
      if (marker._events.alreadyHooked) { return; }
      const origin = arr[0].fn;
      arr[0].fn = function(a) {
        try {
          const self = this || marker;
          // Legacy-fast path: if sentinel 'r' was used, just invoke original handler with no event
          try { if (a === 'r' || (a && a[0] === 'r')) { return origin.call(self); } } catch(_) {}
          // Detect remote-replay via object payload as well
          const isRemoteObj = !!(a && typeof a === 'object' && a.__remote === true);
          // Emit first to minimize latency for locals only
          if (!isRemoteObj) {
            try {
              const ll = self && (self._latlng || (self.getLatLng && self.getLatLng()));
              if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
                const col = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
                log('emit point clicked', ll, col);
                emit.pointClicked && emit.pointClicked({ lat: ll.lat, lng: ll.lng, color: col });
              }
            } catch (_) {}
          }
          // Then call origin handler for local behavior, preserving context.
          try {
            if (isRemoteObj) {
              const ll = self && (self._latlng || (self.getLatLng && self.getLatLng())) || {};
              const syntheticEvt = { type: 'click', target: self, sourceTarget: self, layer: self, latlng: ll, originalEvent: { isRemoteReplay: true } };
              const evt = (a && typeof a === 'object') ? Object.assign({ type: 'click', target: self, sourceTarget: self, layer: self }, a) : syntheticEvt;
              return origin.call(self, evt);
            }
            return origin.call(self, a);
          } catch (_) { return origin.call(self); }
        } catch (_) { try { return origin.call(this, a); } catch (__) {} }
      };
      arr[0].fn.__squadWrappedPoints = true;
      marker._events.alreadyHooked = true;
      log('hooked CircleMarker click', marker._latlng);
    } catch (_) {}
  }

  function hookExistingMarkers(map) {
    try {
      if (!map) return;
      const layers = (map && map._layers) || {};
      let cnt = 0;
      Object.keys(layers).forEach(k => {
        const l = layers[k];
        try { if (l && l instanceof (window.L && L.CircleMarker)) { hookClickableMarker(l); cnt++; } } catch (_) {}
      });
      vlog('hookExistingMarkers scanned=', Object.keys(layers).length, 'hooked=', cnt);
    } catch (_) {}
  }

  function ensureInitHooksOnce() {
    try {
      if (!window.L) return;
      if (L.CircleMarker && !L.CircleMarker.__squadPointsInitHooked) {
        L.CircleMarker.addInitHook(function () {
          const m = this;
          // Hook as soon as possible to minimize startup latency
          setTimeout(() => { try { hookClickableMarker(m); } catch (_) {} }, 10);
        });
        L.CircleMarker.__squadPointsInitHooked = true;
        log('installed CircleMarker init hook');
      }
      if (L.Map && !L.Map.__squadPointsMapHooked) {
        L.Map.addInitHook(function () {
          const map = this;
          if (map.__pointsCtrlHooked) return; // guard
          map.__pointsCtrlHooked = true;
          log('attach ctrl/meta click emitter to map');
          try {
            map.on('click', (e) => {
              try {
                const oe = e && e.originalEvent;
                const ll = e && e.latlng;
                if (!oe || !ll) return;
                if (oe.ctrlKey || oe.metaKey) {
                  const col = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
                  log('ctrl/meta click emit', ll, col);
                  // Local ping
                  showIncomingClickPing(map, { lat: ll.lat, lng: ll.lng, color: col });
                  // Emit with color
                  emit.pointClicked && emit.pointClicked({ lat: ll.lat, lng: ll.lng, color: col });
                }
              } catch (_) {}
            });
          } catch (_) {}
        });
        L.Map.__squadPointsMapHooked = true;
      }
    } catch (_) {}
  }

  function showIncomingClickPing(map, p) {
    try {
      if (!map || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
      const ll = L.latLng(p.lat, p.lng);
      const col = (p && p.color) || (typeof window !== 'undefined' && window.userColor) || '#ff6600';
      const layer = L.circleMarker(ll, { radius: 10, color: col, weight: 2, fillColor: col, fillOpacity: 0.35, opacity: 1 });
      layer.addTo(map);
      let t = 0; const total = 650; const start = performance.now();
      function step(ts) {
        t = (ts - start);
        const k = Math.min(1, t / total);
        const r = 10 + k * 22; const op = 1 - k;
        try { layer.setStyle({ radius: r, opacity: op, fillOpacity: 0.2 * op }); } catch (_) {}
        if (k < 1) requestAnimationFrame(step); else { try { map.removeLayer(layer); } catch (_) {} }
      }
      requestAnimationFrame(step);
    } catch (_) {}
  }

  // Wait until at least one replay target exists to avoid starting too early on slow/SPA loads
  function waitForReplayReadiness(clicks, maxWaitMs = 6000) {
    return new Promise((resolve) => {
      try {
        const started = Date.now();
        const tick = () => {
          try {
            const map = window && window.squadMap;
            if (!map || !window.L) {
              if (Date.now() - started >= maxWaitMs) return resolve();
              return setTimeout(tick, 150);
            }
            // Always (re)hook any CircleMarkers that appeared
            try { hookExistingMarkers(map); } catch (_) {}
            const layers = (map && map._layers) || {};
            let found = false;
            for (const k of Object.keys(layers)) {
              const l = layers[k];
              if (l && l._latlng && l._events && l._events.click) { found = true; break; }
            }
            if (found) { log('replay readiness: at least one target present'); return resolve(); }
            if (Date.now() - started >= maxWaitMs) { log('replay readiness: timeout, proceeding anyway'); return resolve(); }
            setTimeout(tick, 200);
          } catch (_) { try { resolve(); } catch (__) {} }
        };
        // initial slight delay to let immediate DOM/Leaflet churn settle
        setTimeout(tick, 250);
      } catch (_) { try { resolve(); } catch (__) {} }
    });
  }

  function coordsClose(a, b, tol = 1e-7) {
    try {
      if (!a || !b) return false;
      const dLat = Math.abs((a.lat || 0) - (b.lat || 0));
      const dLng = Math.abs((a.lng || 0) - (b.lng || 0));
      return dLat <= tol && dLng <= tol;
    } catch (_) { return false; }
  }

  // Fixed cadence: wait pre-delay, bounded attempts, then post-delay before resolving
  function clickWithFixedCadence(latlng, opts = {}) {
    const pre = Number.isFinite(opts.pre) ? opts.pre : FIXED_PRE_DELAY_MS;
    const post = Number.isFinite(opts.post) ? opts.post : FIXED_POST_DELAY_MS;
    const attempts = Number.isFinite(opts.attempts) ? opts.attempts : FIXED_ATTEMPTS;
    const gap = Number.isFinite(opts.gap) ? opts.gap : FIXED_ATTEMPT_SPACING_MS;
    return new Promise((resolve) => {
      try {
        setTimeout(() => {
          let fired = false;
          const doAttempt = (left) => {
            if (fired) return;
            try {
              const map = window && window.squadMap;
              if (map) hookExistingMarkers(map);
              const layers = (map && map._layers) || {};
              for (const k of Object.keys(layers)) {
                const layer = layers[k];
                if (layer && layer._latlng && layer._events && layer._events.click) {
                  const ll = layer._latlng;
                  try {
                    if ((ll.equals && ll.equals(latlng)) || coordsClose(ll, latlng, 1)) {
                      try { layer.fire && layer.fire('click', 'r'); } catch (_) {}
                      fired = true;
                      return setTimeout(resolve, post);
                    }
                  } catch (_) {}
                }
              }
            } catch (_) {}
            if (left > 0) return setTimeout(() => doAttempt(left - 1), gap);
            // No fire; still respect post delay to keep cadence consistent
            return setTimeout(resolve, post);
          };
          doAttempt(attempts);
        }, pre);
      } catch (_) { try { setTimeout(resolve, post); } catch (__) {} }
    });
  }

  async function replayClicksSequential(clicks) {
    try {
      __replayInProgress = true;
      for (const c of clicks) {
        const latlng = (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) ? L.latLng(c.lat, c.lng) : c;
        // Use fixed cadence to avoid racing marker creation
        await clickWithFixedCadence(latlng);
      }
      log('replayClicksSequential done, count=', clicks.length);
    } catch (_) {}
    finally { __replayInProgress = false; }
  }

  // Public API
  function onRemotePoint(p) {
    try {
      const map = window && window.squadMap;
      if (!map || !p) return;
      log('onRemotePoint', p);
      showIncomingClickPing(map, p);
      const ll = L.latLng(p.lat, p.lng);
      // Enqueue and process sequentially after readiness to avoid premature firing on hard reloads
      __incomingQueue.push(ll);
      __processIncomingQueue();
    } catch (_) {}
  }

  function onStateInit(st) {
    try {
      ensureInitHooksOnce();
      const map = window && window.squadMap;
      if (map) {
        hookExistingMarkers(map);
        // also ensure ctrl/meta listener is attached for existing map
        try {
          if (!map.__pointsCtrlHooked) {
            map.__pointsCtrlHooked = true;
            log('attach ctrl/meta click emitter to existing map');
            map.on('click', (e) => {
              try {
                const oe = e && e.originalEvent;
                const ll = e && e.latlng;
                if (!oe || !ll) return;
                if (oe.ctrlKey || oe.metaKey) {
                  const col = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
                  log('ctrl/meta click emit', ll, col);
                  // Show local ping immediately
                  showIncomingClickPing(map, { lat: ll.lat, lng: ll.lng, color: col });
                  // Emit with color so remotes can use it
                  emit.pointClicked && emit.pointClicked({ lat: ll.lat, lng: ll.lng, color: col });
                }
              } catch (_) {}
            });
          }
        } catch (_) {}
      }
      const clicks = Array.isArray(st && st.clicks) ? st.clicks.slice() : [];
      const path = (st && st.currentMap) || (function(){ try { return (window.location.pathname||'')+(window.location.search||''); } catch(_){ return ''; } })();
      const sig = clicksSignature(clicks, path);
      log('state init for points: clicks=', clicks.length, 'sig=', sig, 'prevSig=', __lastReplaySig, 'inProgress=', __replayInProgress);
      if (!clicks.length) return;
      if (__replayInProgress) { log('skip replay: already in progress'); return; }
      if (__lastReplaySig && __lastReplaySig === sig) { log('skip replay: same signature'); return; }
      // Wait until we see at least one replay target so we don't start too early
      waitForReplayReadiness(clicks, 7000).then(() => {
        try {
          __lastReplaySig = sig; // mark only when starting
          replayClicksSequential(clicks);
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Install hooks immediately if possible
  try {
    ensureInitHooksOnce();
    if (window && window.squadMap) {
      const map = window.squadMap;
      hookExistingMarkers(map);
      if (!map.__pointsCtrlHooked) {
        map.__pointsCtrlHooked = true;
        map.on('click', (e) => {
          try {
            const oe = e && e.originalEvent;
            const ll = e && e.latlng;
            if (!oe || !ll) return;
            if (oe.ctrlKey || oe.metaKey) {
              const col = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
              log('ctrl/meta click emit', ll, col);
              showIncomingClickPing(map, { lat: ll.lat, lng: ll.lng, color: col });
              emit.pointClicked && emit.pointClicked({ lat: ll.lat, lng: ll.lng, color: col });
            }
          } catch (_) {}
        });
      }
    }
  } catch (_) {}

  return { onRemotePoint, onStateInit };
}
