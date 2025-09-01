// filepath: src/userscript/main-bootstrap.js
import { initUnits } from './units.js';
import { initRightClick } from './rightclick.js';
// Future modules (created progressively during migration)
import { initDraw, applyRemoteDrawCreate, applyRemoteDrawEdit, applyRemoteDrawDelete, applyRemoteDrawProgress, recheckDrawToolbar } from './modules/draw.js';
import { initMarkers } from './modules/markers.js';
import { initPresence } from './modules/presence.js';
import { initViewSync } from './modules/view-sync.js';
import { initSocket } from './modules/sockets.js';
import { initToolbarExtras } from './modules/toolbar-extras.js';
import { initPoints } from './modules/points.js';
import { initKeyboard } from './modules/keyboard.js';
import { initLeafletEventsShim } from './modules/leaflet-events-shim.js';
import { initSquadMarkers } from './modules/squad-markers.js';

function __isActiveMapPath() { try { const p = (window.location && (window.location.pathname||'')) || ''; return p.startsWith('/map'); } catch(_) { return false; } }

function __hostWindow() { try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; } catch (_) { return window; } }

function waitForLeaflet() {
  try { const W = __hostWindow(); return !!(typeof W !== 'undefined' && W.L && W.L.Map); } catch(_) { return !!(typeof window !== 'undefined' && window.L && L.Map); }
}

function installMapCapture() {
  try {
    if (!waitForLeaflet()) return false;
    const W = __hostWindow();
    const Lw = W && W.L;
    if (!Lw || !Lw.Map) return false;
    if (Lw.Map && !Lw.Map.__squadCapturePatched) {
      const Proto = Lw.Map.prototype;
      const origInit = Proto.initialize;
      Proto.initialize = function() {
        const res = origInit.apply(this, arguments);
        try { if (!W.squadMap) W.squadMap = this; window.squadMap = this; } catch (_) {}
        try { this.once && this.once('load', () => { try { if (!W.squadMap) W.squadMap = this; window.squadMap = this; } catch (_) {} }); } catch (_) {}
        return res;
      };
      Lw.Map.__squadCapturePatched = true;
    }
    if (Lw.Map && Lw.Map.addInitHook && !Lw.Map.__squadInitHookPatched) {
      Lw.Map.addInitHook(function() {
        try { __hostWindow().squadMap = this; window.squadMap = this; } catch (_) {}
        try {
          const WW = __hostWindow();
          const p = (WW.location && (WW.location.pathname || '')) + (WW.location && (WW.location.search || ''));
          window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: p } }));
        } catch (_) {}
      });
      Lw.Map.__squadInitHookPatched = true;
    }
    // Also patch common methods to capture an existing map on first use
    try {
      if (!Lw.Map.__squadCaptureMethodsPatched) {
        const methods = ['setView', 'panTo', 'flyTo', 'fitBounds', 'addLayer'];
        methods.forEach((name) => {
          try {
            const orig = Lw.Map.prototype[name];
            if (typeof orig !== 'function') return;
            Lw.Map.prototype[name] = function() {
              try { __hostWindow().squadMap = this; window.squadMap = this; } catch (_) {}
              return orig.apply(this, arguments);
            };
          } catch (_) {}
        });
        Lw.Map.__squadCaptureMethodsPatched = true;
      }
    } catch (_) {}
    return true;
  } catch (_) { return false; }
}

export function bootstrap() {
  // Install Leaflet event shim ASAP (it will self-install when Leaflet is present)
  try { initLeafletEventsShim(); } catch (_) {}

  // Modular bootstrap: call initUnits immediately; defer others until Leaflet is present
  try { initUnits(); } catch (_) {}
  try { initRightClick(); } catch (_) {}
  try { initKeyboard(); } catch (_) {}

  function start() {
    // Ensure we capture the map instance when created
    try { installMapCapture(); } catch (_) {}

    // Socket first so we can pass emitters into modules
    let viewSync = { applyRemoteViewIfPossible: (_)=>false };
    let presenceApi = null;
    let pointsApi = null;
    let socket = null;

    // Buffer for drawings arriving before the map/group exists
    let pendingOps = [];
    let flushTimer = null;
    const mapReady = () => { try { const W = __hostWindow(); return !!(W && W.squadMap && W.L && (W.squadMap instanceof W.L.Map)); } catch (_) { return false; } };
    const scheduleFlush = () => {
      if (flushTimer) return;
      let tries = 0;
      flushTimer = setInterval(() => {
        tries++;
        try {
          if (mapReady()) {
            const toApply = pendingOps.slice();
            pendingOps = [];
            toApply.forEach((op) => {
              try {
                if (!op || !op.type) return;
                if (op.type === 'create') applyRemoteDrawCreate(op.shape);
                else if (op.type === 'edit') applyRemoteDrawEdit(op.shapes);
                else if (op.type === 'delete') applyRemoteDrawDelete(op.ids);
              } catch (_) {}
            });
            clearInterval(flushTimer);
            flushTimer = null;
          }
        } catch (_) {}
        if (tries > 120) { clearInterval(flushTimer); flushTimer = null; }
      }, 250);
    };

    // Simple map path sync helpers
    const currentPath = () => {
      try { return (window.location.pathname || '') + (window.location.search || ''); } catch (_) { return ''; }
    };
    const shouldEmitForPath = (p) => { try { return !!(p && p !== '/'); } catch (_) { return false; } };
    let suppressNextMapEmit = false;
    let pendingStateForPoints = null;

    // Lightweight debug helper
    const dlog = (...args) => { try { const ts = new Date().toISOString(); console.log('[bootstrap]', ts, ...args); } catch (_) {} };

    // Consume suppression flag if set (from hard navigation)
    try {
      const SUPPRESS_KEY = 'squadmapsSuppressMapEmit';
      const s = sessionStorage.getItem(SUPPRESS_KEY);
      if (s === '1') {
        suppressNextMapEmit = true;
        sessionStorage.removeItem(SUPPRESS_KEY);
        dlog('consume suppressNextMapEmit from sessionStorage');
      }
    } catch (_) {}

    try {
      socket = initSocket({
        onConnected: (id) => {
          try { presenceApi && presenceApi.onConnected && presenceApi.onConnected(id); } catch (_) {}
          // Emit saved username once on connect if available
          try { const name = (localStorage.getItem('squadmapsUsername') || '').trim(); if (name && socket && socket.emit && socket.emit.usernameSet) socket.emit.usernameSet({ name }); } catch (_) {}
        },
        onStateInit: (st) => {
          try {
            // If server has a canonical map path, navigate if different
            try {
              const desired = st && st.currentMap;
              const here = currentPath();
              if (typeof desired === 'string' && desired && desired !== here) {
                dlog('onStateInit: navigating to server map', { desired, here });
                suppressNextMapEmit = true;
                try { sessionStorage.setItem('squadmapsSuppressMapEmit', '1'); } catch (_) {}
                try {
                  const base = (window.location && window.location.origin) || '';
                  window.location = base + desired;
                  dlog('onStateInit: set window.location for hard nav');
                } catch (_) {
                  try { window.history && window.history.replaceState && window.history.replaceState(null, '', desired); dlog('onStateInit: replaceState fallback used'); } catch (__) {}
                }
                return; // stop further init; page will change or URL updated
              }
            } catch (_) {}

            // hydrate drawings; queue if map not ready yet
            const drawings = (st && st.drawings) || [];
            if (!mapReady()) {
              drawings.forEach((d) => { pendingOps.push({ type: 'create', shape: d }); });
              scheduleFlush();
              dlog('onStateInit: queued drawings until map ready', { count: drawings.length });
            } else {
              drawings.forEach((d) => { try { applyRemoteDrawCreate(d); } catch (_) {} });
              dlog('onStateInit: applied drawings immediately', { count: drawings.length });
            }
            // presence state/users
            try { presenceApi && presenceApi.onStateInit && presenceApi.onStateInit(st); } catch (_) {}

            // Buffer for points module; it will pick this up after init
            pendingStateForPoints = st;
            try { if (pointsApi && pointsApi.onStateInit) { pointsApi.onStateInit(st); pendingStateForPoints = null; dlog('onStateInit: delivered to points immediately'); } } catch (_) {}
          } catch (_) {}
        },
        onDrawCreate: (shape) => {
          try {
            if (!mapReady()) { pendingOps.push({ type: 'create', shape }); scheduleFlush(); dlog('buffer draw create; map not ready'); }
            else { applyRemoteDrawCreate(shape); }
          } catch (_) {}
        },
        onDrawEdit: (shapes) => {
          try {
            if (!mapReady()) { pendingOps.push({ type: 'edit', shapes }); scheduleFlush(); dlog('buffer draw edit; map not ready'); }
            else { applyRemoteDrawEdit(shapes); }
          } catch (_) {}
        },
        onDrawDelete: (ids) => {
          try {
            if (!mapReady()) { pendingOps.push({ type: 'delete', ids }); scheduleFlush(); dlog('buffer draw delete; map not ready'); }
            else { applyRemoteDrawDelete(ids); }
          } catch (_) {}
        },
        onViewChanged: (view) => {
          try {
            viewSync && viewSync.applyRemoteViewIfPossible && viewSync.applyRemoteViewIfPossible(view);
             // No staging fallback; if not applied immediately, presence follow or later events will adjust the view
           } catch (_) {}
         },
        onPresenceUpdate: (delta) => { try { presenceApi && presenceApi.onPresenceUpdate && presenceApi.onPresenceUpdate(delta); } catch (_) {} },
        onUserJoined: (u) => { try { presenceApi && presenceApi.onUserJoined && presenceApi.onUserJoined(u); } catch (_) {} },
        onUserLeft: (u) => { try { presenceApi && presenceApi.onUserLeft && presenceApi.onUserLeft(u); } catch (_) {} },
        onUserUpdated: (u) => { try { presenceApi && presenceApi.onUserUpdated && presenceApi.onUserUpdated(u); } catch (_) {} },
        onPointClicked: (p) => {
          try {
            if (pointsApi && pointsApi.onRemotePoint) pointsApi.onRemotePoint(p);
          } catch (_) {}
        },
        onMapChanged: (m) => {
          try {
            const cur = currentPath();
            if (typeof m === 'string' && m && m !== cur && m !== '/') {
              dlog('onMapChanged: received remote path', { m, cur });
              suppressNextMapEmit = true;
              try { sessionStorage.setItem('squadmapsSuppressMapEmit', '1'); } catch (_) {}
              try {
                const base = (window.location && window.location.origin) || '';
                window.location = base + m;
                dlog('onMapChanged: set window.location for hard nav');
              } catch (_) {
                try { window.history && window.history.pushState && window.history.pushState(null, '', m); dlog('onMapChanged: used pushState fallback'); } catch (__) {}
                try { window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: m } })); dlog('onMapChanged: dispatched mapPathChanged after pushState'); } catch (__) {}
              }
            } else {
              dlog('onMapChanged: ignored (same or empty path)', { m, cur });
            }
          } catch (_) {}
        },
        onDrawProgress: (p) => { try { applyRemoteDrawProgress && applyRemoteDrawProgress(p); } catch (_) {} },
      });
    } catch (_) {}

    // Initialize UI modules now that socket exists
    try {
      const emit = (socket && socket.emit) || {};

      // Re-attach UI bits when map path changes via SPA or remote push (install early so we catch initial dispatch)
      try {
        if (!window.__squadmapsUiMapPathListener) {
          window.addEventListener('squadmaps:mapPathChanged', (ev) => {
            try {
              const path = ev && ev.detail && ev.detail.path; dlog('mapPathChanged received', { path });
              // Reinstall capture hooks in case Leaflet was reloaded by SPA
              try { installMapCapture(); } catch (_) {}
              // Skip ensures on non-map selector
              if (!__isActiveMapPath()) { dlog('reattach: skipped on non-map path'); return; }
              // try immediately and then a few retries in case map/Draw attach late
              const delays = [0, 150, 350, 700, 1200, 2000, 3500];
              let done = false;
              const total = delays.length;
              const tryOnce = (ms, idx) => setTimeout(() => {
                try {
                  if (done) { if (idx === 0) dlog('reattach: already satisfied, skipping queued attempts'); return; }
                  const W = __hostWindow();
                  const hasMap = !!(W && W.squadMap && W.L && (W.squadMap instanceof W.L.Map));
                  const hasDraw = !!(W && W.L && W.L.Control && W.L.Control.Draw);
                  // If map not detected yet but a Leaflet container exists, nudge Leaflet to emit events
                  if (!hasMap) {
                    try {
                      const cont = document.querySelector && document.querySelector('.leaflet-container');
                      if (cont) {
                        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
                        try { cont.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 })); } catch (_) {}
                      }
                    } catch (_) {}
                  }
                  const m = W && W.squadMap;
                  const el = m && m._container;
                  const hasToolbar = !!(el && el.querySelector && el.querySelector('.leaflet-draw-toolbar.leaflet-bar'));
                  const hasCtrl = !!(m && m.__squadmapsDrawControl);
                  const hasExtras = !!document.getElementById('squadmaps-color-button');
                  const hasMarkers = !!document.getElementById('squadmaps-marker-picker-btn');
                  dlog('reattach attempt', { attempt: idx + 1, delayMs: ms, hasMap, hasDraw, hasToolbar, hasCtrl, hasExtras, hasMarkers });

                  // Perform ensures (only on /map path)
                  recheckDrawToolbar();
                  initToolbarExtras();
                  initMarkers();
                  initDraw({ emit: { drawCreate: emit.drawCreate, drawEdit: emit.drawEdit, drawDelete: emit.drawDelete, drawProgress: emit.drawProgress } });
                  initSquadMarkers();

                  // Re-evaluate success after actions
                  let okToolbar = false, okCtrl = false;
                  try {
                    const mm = W && W.squadMap; const ee = mm && mm._container;
                    okToolbar = !!(ee && ee.querySelector && ee.querySelector('.leaflet-draw-toolbar.leaflet-bar'));
                    okCtrl = !!(mm && mm.__squadmapsDrawControl);
                  } catch (_) {}
                  const ok = (W && W.squadMap) && hasDraw && okToolbar && okCtrl;
                  if (ok) {
                    done = true;
                    dlog('reattach success', { attempt: idx + 1 });
                    return;
                  }
                  if (idx === total - 1 && !done) {
                    dlog('reattach: exhausted attempts without confirming attach');
                  }
                } catch (_) {}
              }, ms);
              delays.forEach((ms, idx) => tryOnce(ms, idx));

              // Fallback: longer wait for late map creation (up to ~15s)
              let waited = 0;
              const waitIv = setInterval(() => {
                try {
                  if (done) { clearInterval(waitIv); return; }
                  if (!__isActiveMapPath()) { clearInterval(waitIv); dlog('late wait: skipped on non-map path'); return; }
                  waited += 500;
                  const W = __hostWindow();
                  const hasMap = !!(W && W.squadMap && W.L && (W.squadMap instanceof W.L.Map));
                  if (!hasMap) {
                    try { const cont = document.querySelector && document.querySelector('.leaflet-container'); if (cont) { try { window.dispatchEvent(new Event('resize')); } catch (_) {} try { cont.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 6, clientY: 6 })); } catch (_) {} } } catch (_) {}
                  }
                  if (hasMap && !done) {
                    dlog('late map detected; running ensure sequence');
                    recheckDrawToolbar();
                    initToolbarExtras();
                    initMarkers();
                    initDraw({ emit: { drawCreate: emit.drawCreate, drawEdit: emit.drawEdit, drawDelete: emit.drawDelete, drawProgress: emit.drawProgress } });
                    initSquadMarkers();
                    // confirm
                    const m = W && W.squadMap; const el = m && m._container;
                    const okToolbar = !!(el && el.querySelector && el.querySelector('.leaflet-draw-toolbar.leaflet-bar'));
                    const okCtrl = !!(m && m.__squadmapsDrawControl);
                    if (okToolbar && okCtrl) { done = true; clearInterval(waitIv); dlog('reattach success (late)'); }
                  }
                  if (waited >= 15000) { clearInterval(waitIv); if (!done) dlog('late wait timeout; toolbar still not confirmed'); }
                } catch (_) {}
              }, 500);
            } catch (_) {}
          });
          window.__squadmapsUiMapPathListener = true;
          dlog('installed mapPathChanged UI listener');
        }
      } catch (_) {}

      // Emit initial map path (skip root '/')
      try {
        const p = currentPath();
        if (!suppressNextMapEmit && shouldEmitForPath(p)) {
          dlog('initial mapChanged emit', { path: p });
          emit.mapChanged && emit.mapChanged(p);
          try { window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: p } })); dlog('initial: dispatched mapPathChanged'); } catch (_) {}
        } else { dlog('initial mapChanged emit suppressed', { suppressNextMapEmit, path: p }); suppressNextMapEmit = false; try { window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: p } })); dlog('initial: dispatched mapPathChanged (emit suppressed)'); } catch (_) {} }
      } catch (_) {}
      // Emit on popstate (back/forward)
      try {
        window.addEventListener('popstate', () => {
          if (suppressNextMapEmit) { dlog('popstate: suppressNextMapEmit consumed'); suppressNextMapEmit = false; return; }
          try {
            const p = currentPath();
            if (shouldEmitForPath(p)) { emit.mapChanged && emit.mapChanged(p); dlog('popstate: emitted mapChanged', { path: p }); }
            try { window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: p } })); dlog('popstate: dispatched mapPathChanged'); } catch (__) {}
          } catch (_) {}
        });
      } catch (_) {}
      // Patch pushState/replaceState to emit map changes (skip root '/')
      try {
        const hist = window.history;
        const wrap = (fnName) => {
          const orig = hist[fnName];
          if (typeof orig !== 'function') return;
          hist[fnName] = function() {
            const ret = orig.apply(this, arguments);
            try {
              const p = currentPath();
              if (suppressNextMapEmit) { dlog(fnName + ': suppressNextMapEmit consumed'); suppressNextMapEmit = false; }
              else { if (shouldEmitForPath(p)) { emit.mapChanged && emit.mapChanged(p); dlog(fnName + ': emitted mapChanged', { path: p }); } }
              try { window.dispatchEvent(new CustomEvent('squadmaps:mapPathChanged', { detail: { path: p } })); dlog(fnName + ': dispatched mapPathChanged'); } catch (__) {}
            } catch (_) {}
            return ret;
          };
        };
        wrap('pushState'); wrap('replaceState');
      } catch (_) {}

      viewSync = initViewSync({ emit: { viewChanged: emit.viewChanged } });
      presenceApi = initPresence({ applyRemoteView: (v) => viewSync.applyRemoteViewIfPossible && viewSync.applyRemoteViewIfPossible(v), isApplying: () => (viewSync.isApplying && viewSync.isApplying()) });
      presenceApi && presenceApi.setEmit && presenceApi.setEmit({ presenceUpdate: emit.presenceUpdate, usernameSet: emit.usernameSet });
      // Init drawings and toolbar extras
      initDraw({ emit: { drawCreate: emit.drawCreate, drawEdit: emit.drawEdit, drawDelete: emit.drawDelete, drawProgress: emit.drawProgress } });
      initToolbarExtras();
      initMarkers();
      initSquadMarkers();
      // Keyboard already initialized globally; no per-map action needed
      dlog('UI modules initialized');

      // Init points sync (legacy-compatible)
      pointsApi = initPoints({ emit: { pointClicked: emit.pointClicked } });
      if (pendingStateForPoints) { try { pointsApi.onStateInit && pointsApi.onStateInit(pendingStateForPoints); pendingStateForPoints = null; dlog('delivered buffered state to points'); } catch (_) {} }

      // Removed duplicate ctrl/meta click broadcaster here; points module owns it now
    } catch (_) {}
  }

  if (waitForLeaflet()) {
    start();
  } else {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (waitForLeaflet()) { clearInterval(t); start(); }
      if (tries > 60) clearInterval(t);
    }, 500);
  }
}
