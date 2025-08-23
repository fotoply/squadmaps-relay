// Markers module: provides a Font Awesome marker picker button and updates marker icon.
// Safe to call multiple times; guarded to run once per page.

let __markersInitOnce = false;
let __markersPollTimer = null;
let __markersSyncedOnce = false;
const AVAILABLE_MARKER_ICONS = [
  'location-dot', 'map-pin', 'flag', 'star', 'triangle-exclamation', 'crosshairs', 'skull-crossbones', 'circle'
];
const KEY = 'squadmapsMarkerIcon';
let __radialEl = null;
let __radialClosedCbs = [];
let __radialMarkerRef = null; // track marker tied to the open radial

function ensureFA() {
  if (document.getElementById('squadmaps-fa')) return;
  const link = document.createElement('link');
  link.id = 'squadmaps-fa';
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  document.head.appendChild(link);
}

function ensureCss() {
  // Only radial menu styling retained; toolbar picker removed
  if (!document.getElementById('squadmaps-marker-picker-css')) {
    const st = document.createElement('style');
    st.id = 'squadmaps-marker-picker-css';
    st.textContent = `#squadmaps-marker-radial i{font-size:18px}`;
    document.head.appendChild(st);
  }
}

function loadChoice() {
  try {
    const v = localStorage.getItem(KEY);
    if (v && AVAILABLE_MARKER_ICONS.includes(v)) return v;
  } catch (_) {}
  return 'location-dot';
}
function saveChoice(v) { try { localStorage.setItem(KEY, v); } catch (_) {} }

function setDrawMarkerIcon(iconName) {
  try {
    const map = window.squadMap;
    const ctrl = map && map.__squadmapsDrawControl;
    if (!ctrl || !ctrl.options || !ctrl.options.draw) return;
    const color = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
    const size = 48, fontSize = 35;
    const centerAnchored = iconName === 'crosshairs' || iconName === 'circle';
    const anchor = centerAnchored ? [size/2, size/2] : [Math.round(size/2), size - 5];
    const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${iconName}" style="color:${color};font-size:${fontSize}px;line-height:1"></i></div>`;
    ctrl.options.draw.marker = ctrl.options.draw.marker || {};
    ctrl.options.draw.marker.icon = L.divIcon({ className: 'leaflet-div-icon squad-fa-marker-wrap', html, iconSize: [size,size], iconAnchor: anchor });
    ctrl.options.draw.marker.iconName = iconName;
    try { window.__squadMarkerIconName = iconName; } catch (_) {}
  } catch (_) {}
}

function closeRadial() {
  try { if (__radialEl && __radialEl.parentElement) __radialEl.parentElement.removeChild(__radialEl); } catch (_) {}
  __radialEl = null;
  try { window.__squadMarkerRadialOpen = false; } catch (_) {}
  // removed per-module Escape key listener; handled by keyboard module
  try { document.removeEventListener('click', onDocClick, true); } catch (_) {}
  try { const map = window.squadMap; map && map.off && map.off('movestart', closeRadial); map && map.off && map.off('zoomstart', closeRadial); } catch (_) {}
  try { const cbs = __radialClosedCbs.slice(); __radialClosedCbs.length = 0; cbs.forEach(fn => { try { fn(); } catch (_) {} }); } catch (_) {}
}

function onDocClick(e) { if (!__radialEl) return; if (__radialEl.contains(e.target)) return; closeRadial(); }

function openRadialForMarker(marker) {
  try { closeRadial(); } catch (_) {}
  const map = window.squadMap; if (!map || !marker) return;
  __radialMarkerRef = marker; // remember marker for potential cancel
  try { window.__squadMarkerRadialOpen = true; } catch (_) {}
  ensureFA(); ensureCss();
  const centerPt = map.latLngToContainerPoint(marker.getLatLng());
  const N = AVAILABLE_MARKER_ICONS.length;
  const radius = 84;
  const wrap = document.createElement('div'); wrap.id = 'squadmaps-marker-radial'; Object.assign(wrap.style, { position:'absolute', left:centerPt.x+'px', top:centerPt.y+'px', zIndex:10000, width:'0', height:'0', pointerEvents:'none' });
  AVAILABLE_MARKER_ICONS.forEach((name, idx) => {
    const ang = (Math.PI * 2 * idx) / N - Math.PI / 2;
    const x = Math.cos(ang) * radius; const y = Math.sin(ang) * radius;
    const a = document.createElement('a'); a.href = '#'; a.setAttribute('data-icon', name);
    a.innerHTML = `<i class="fa-solid fa-${name}"></i>`;
    Object.assign(a.style, { position:'absolute', left:`${x}px`, top:`${y}px`, transform:'translate(-50%,-50%)', width:'44px', height:'44px', borderRadius:'50%', background: name === loadChoice() ? '#2563eb' : '#171718', border:'1px solid #2a2a2b', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 2px 6px rgba(0,0,0,0.45)', pointerEvents:'auto' });
    a.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      saveChoice(name);
      try { marker.__faIconName = name; } catch (_) {}
      try { setDrawMarkerIcon(name); } catch (_) {}
      try {
        const col = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
        const size = 48, fontSize = 35;
        const centerAnchored = name === 'crosshairs' || name === 'circle';
        const anchor = centerAnchored ? [size/2, size/2] : [Math.round(size/2), size - 5];
        const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${name}" style="color:${col};font-size:${fontSize}px;line-height:1"></i></div>`;
        marker.setIcon(L.divIcon({ className: 'leaflet-div-icon squad-fa-marker-wrap', html, iconSize: [size,size], iconAnchor: anchor }));
      } catch (_) {}
      // Notify draw module to emit an edit for this marker
      try { const mapRef = window.squadMap; mapRef && mapRef.fire && mapRef.fire('squad:markerIconChanged', { layer: marker }); } catch (_) {}
      closeRadial();
      __radialMarkerRef = null; // confirmed selection; no cancel pending anymore
    });
    wrap.appendChild(a);
  });
  try { map._container.style.position = map._container.style.position || 'relative'; } catch (_) {}
  (map._container || document.body).appendChild(wrap);
  __radialEl = wrap;
  document.addEventListener('click', onDocClick, true);
  // Right-click on the radial cancels placement
  try {
    wrap.addEventListener('contextmenu', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
      try { if (typeof window.__squadCancelMarkerRadial === 'function') window.__squadCancelMarkerRadial(); } catch (_) {}
    }, true);
  } catch (_) {}
  try { map.on && map.on('movestart', closeRadial); map.on && map.on('zoomstart', closeRadial); } catch (_) {}
}

// Expose small globals so draw module can coordinate continuous-mode deferral
try {
  window.__squadOpenMarkerRadial = openRadialForMarker;
  window.__squadOnMarkerRadialClosedOnce = (cb) => { if (!cb) return; if (!window.__squadMarkerRadialOpen) { try { cb(); } catch(_) {} return; } __radialClosedCbs.push(cb); };
  // Also expose a closer so the keyboard module can close on Escape
  window.__squadCloseMarkerRadial = closeRadial;
  // New: expose a cancel function that deletes the placeholder marker tied to the open radial
  window.__squadCancelMarkerRadial = () => {
    try {
      const map = (typeof window !== 'undefined' && window.squadMap) || null;
      const m = __radialMarkerRef;
      if (map && m) {
        try { map.fire && map.fire('squad:cancelRadialMarker', { layer: m }); } catch (_) {}
      }
    } catch (_) {}
    try { __radialMarkerRef = null; } catch (_) {}
    try { closeRadial(); } catch (_) {}
  };
} catch (_) {}

export function initMarkers() {
  // Register event listener once; allow start() to run multiple times
  const isActiveMapPath = () => { try { const p = (window.location && (window.location.pathname||'')) || ''; return p.startsWith('/map'); } catch(_) { return false; } };
  let tries = 0;

  function start() {
    if (!isActiveMapPath()) return false;
    if (!window || !window.L || !window.squadMap || !(window.squadMap instanceof L.Map)) return false;
    const markerBtn = document.querySelector('.leaflet-draw-draw-marker');
    if (!markerBtn) { /* quiet until present */ return false; }

    // Ensure assets and apply saved choice to draw control; no extra toolbar UI
    ensureFA();
    ensureCss();
    try { setDrawMarkerIcon(loadChoice()); } catch (_) {}
    __markersSyncedOnce = true;
    return true;
  }

  // Try immediately
  if (start()) { /* attached */ }

  // Listen for draw toolbar ready events to re-attach after map changes
  if (!__markersInitOnce) {
    try { window.addEventListener('squadmaps:drawToolbarReady', () => { try { start(); } catch (_) {} }); } catch (_) {}
    __markersInitOnce = true;
  }

  // Fallback polling for first load (singleton)
  if (!__markersPollTimer) {
    __markersPollTimer = setInterval(() => { tries++; if (start()) { clearInterval(__markersPollTimer); __markersPollTimer = null; return; } if (tries > 120) { clearInterval(__markersPollTimer); __markersPollTimer = null; } }, 250);
  }
}
