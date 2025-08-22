// filepath: c:\Users\norbe\IdeaProjects\squadmaps-relay-server\src\userscript\modules\view-sync.js
// View Sync module: adds Sync View toolbar button and exposes applyRemoteViewIfPossible.
// Accepts deps: { emit: { viewChanged }, ensureFA?: function }

let __viewInitOnce = false;
let __isApplying = false;

function ensureFA() {
  if (document.getElementById('squadmaps-fa')) return;
  const link = document.createElement('link');
  link.id = 'squadmaps-fa';
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  document.head.appendChild(link);
}

function buildSyncViewBtn(emit) {
  try {
    if (document.getElementById('squadmaps-sync-view-button')) return;
    const bars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
    if (!bars || !bars.length) { setTimeout(() => buildSyncViewBtn(emit), 400); return; }
    const targetBar = bars[0];
    const btn = document.createElement('a');
    btn.id = 'squadmaps-sync-view-button';
    btn.href = '#';
    btn.title = 'Broadcast current view (center + zoom) to others';
    btn.innerHTML = '<i class="fa-solid fa-arrows-to-circle" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>';
    Object.assign(btn.style, { width: '30px', height: '30px', display: 'block', background: '#171718', color: '#fff', textDecoration: 'none', border: '1px solid #2a2a2b' });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        const map = window.squadMap;
        if (!map) return;
        const c = map.getCenter();
        const z = map.getZoom();
        emit && emit.viewChanged && emit.viewChanged({ center: { lat: c.lat, lng: c.lng }, zoom: z });
      } catch (_) {}
    });
    try { (ensureFA)(); } catch (_) {}
    targetBar.appendChild(btn);
    if (!document.getElementById('squadmaps-sync-view-css')) {
      const st = document.createElement('style');
      st.id = 'squadmaps-sync-view-css';
      st.textContent = '#squadmaps-sync-view-button{box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset;}#squadmaps-sync-view-button:hover{background:#1f1f20;}';
      document.head.appendChild(st);
    }
  } catch (_) {}
}

export function applyRemoteViewIfPossible(view) {
  if (!view || !window || !window.squadMap || !window.L) return false;
  const map = window.squadMap;
  try {
    const { center, zoom } = view || {};
    if (!center || typeof zoom !== 'number') return false;
    const cur = map.getCenter();
    const curZoom = map.getZoom();
    const closePos = cur && Math.abs(cur.lat - center.lat) + Math.abs(cur.lng - center.lng) < 1e-8;
    const closeZoom = Math.abs((curZoom ?? 0) - zoom) < 1e-6;
    if (closePos && closeZoom) return true;
    const target = L.latLng(center.lat, center.lng);
    const opts = { animate: true, duration: 0.8, easeLinearity: 0.25, noMoveStart: false };
    __isApplying = true;
    try {
      if (Math.abs((curZoom ?? zoom) - zoom) < 0.01) {
        map.panTo(target, opts);
      } else if (typeof map.flyTo === 'function') {
        map.flyTo(target, zoom, opts);
      } else {
        map.setView(target, zoom, { animate: true });
      }
    } catch (_) {
      try { map.setView(target, zoom, { animate: true }); } catch (__) {}
    }
    const reset = () => { __isApplying = false; try { map.off('moveend', reset); } catch (_) {} };
    try { map.on('moveend', reset); } catch (_) { __isApplying = false; }
    return true;
  } catch (_) { __isApplying = false; return false; }
}

export function initViewSync(deps = {}) {
  if (__viewInitOnce) return { applyRemoteViewIfPossible, isApplying: () => __isApplying };
  const emit = Object.assign({ viewChanged: (_v)=>{} }, deps.emit || {});

  let tries = 0;
  function start() {
    if (!window || !window.squadMap || !(window.squadMap instanceof (window.L && L.Map))) return false;
    buildSyncViewBtn(emit);
    return true;
  }

  if (!start()) {
    const t = setInterval(() => { tries++; if (start()) { clearInterval(t); return; } if (tries > 120) clearInterval(t); }, 250);
  }

  // Re-attach button if the draw toolbar is rebuilt (e.g., after map change)
  try { window.addEventListener('squadmaps:drawToolbarReady', () => { try { buildSyncViewBtn(emit); } catch (_) {} }); } catch (_) {}

  __viewInitOnce = true;
  return {
    applyRemoteViewIfPossible,
    isApplying: () => __isApplying
  };
}
