// filepath: src/userscript/modules/squad-markers.js
// Squad-specific composite markers module

// Types config (in-game units for radii/width/height)
const TYPES = {
  rally: {
    icon: 'bag-shopping',
    iconOnMap: true,
    color: '#22c55e',
    children: [
      { type: 'circle', radius: 50, color: '#22c55e', dashArray: '6,6', weight: 2, fill: false, interactive: false },
    ],
  },
  fob: {
    icon: 'tent',
    iconOnMap: true,
    color: '#eab308',
    children: [
      { type: 'circle', radius: 150, color: '#eab308', fillColor: '#eab308', fillOpacity: 0.18, weight: 1.5, interactive: false },
      { type: 'circle', radius: 400, color: '#eab308', dashArray: '6,6', weight: 2, fill: false, interactive: false },
    ],
  },
  enemy: {
    icon: 'radio',
    iconOnMap: true,
    color: '#ef4444',
    children: [
      { type: 'circle', radius: 400, color: '#ef4444', dashArray: '6,6', weight: 2, interactive: false },
    ],
  },
  defend: {
    icon: 'shield-alt', // FA5 alias; fallback to shield-halved if needed
    iconOnMap: true,
    color: '#22c55e',
    children: [
      { type: 'square', width: 100, height: 100, color: '#22c55e', dashArray: '6,6', weight: 2, interactive: false },
    ],
  },
};

let __initOnce = false;
let __uiPollTimer = null;
let __activePlacement = null; // { typeKey, onMapClick, onCancel }

function ensureFA() {
  try {
    if (document.getElementById('squadmaps-fa')) return;
    const link = document.createElement('link');
    link.id = 'squadmaps-fa';
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
    document.head.appendChild(link);
  } catch (_) {}
}

function sanitizeFaIcon(name) {
  const n = String(name || '').trim();
  if (n === 'shield-alt') return 'shield-halved';
  return n || 'location-dot';
}

function faDivIcon(iconName, colorHex) {
  ensureFA();
  const icon = sanitizeFaIcon(iconName);
  const color = (typeof colorHex === 'string' ? (colorHex[0] === '#' ? colorHex : '#' + colorHex) : '#ff6600');
  const size = 48, fontSize = 35;
  const centerAnchored = icon === 'crosshairs' || icon === 'circle';
  const anchor = centerAnchored ? [size / 2, size / 2] : [Math.round(size / 2), size - 5];
  const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${icon}" style="color:${color};font-size:${fontSize}px;line-height:1"></i></div>`;
  if (!document.getElementById('squadmaps-fa-marker-css')) {
    const st = document.createElement('style');
    st.id = 'squadmaps-fa-marker-css';
    st.textContent = `.squad-fa-marker-wrap{background:transparent!important;border:0!important;}
.squad-fa-marker-wrap .squad-fa-marker{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.squad-fa-marker-wrap i{pointer-events:none;}`;
    document.head.appendChild(st);
  }
  return L.divIcon({ className: 'leaflet-div-icon squad-fa-marker-wrap', html, iconSize: [size, size], iconAnchor: anchor });
}

function invisibleAnchorIcon() {
  const size = 6;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:transparent"></div>`;
  return L.divIcon({ className: 'leaflet-div-icon', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function kUnits() {
  try { return (typeof window !== 'undefined' && typeof window.getInGameUnitsScale === 'function') ? (window.getInGameUnitsScale() || 0.01) : 0.01; } catch (_) { return 0.01; }
}

function buildChildLayers(center, typeKey) {
  const spec = TYPES[typeKey];
  if (!spec) return [];
  const k = kUnits();
  const out = [];
  (spec.children || []).forEach((c) => {
    const baseOpts = Object.assign({}, c);
    delete baseOpts.type; delete baseOpts.radius; delete baseOpts.width; delete baseOpts.height;
    try {
      if (c.type === 'circle') {
        const r = Number(c.radius) || 0;
        const radMap = (r > 0 && k > 0) ? (r / k) : r;
        const layer = L.circle(center, Object.assign({ radius: Math.max(1, radMap), fill: !!c.fill }, baseOpts));
        out.push(layer);
      } else if (c.type === 'square') {
        // axis-aligned rectangle centered on the marker using planar distances
        const w = Number(c.width) || 0; const h = Number(c.height) || 0;
        const w2 = (w > 0 && k > 0) ? (w / k / 2) : (w / 2);
        const h2 = (h > 0 && k > 0) ? (h / k / 2) : (h / 2);
        const north = L.GeometryUtil && L.GeometryUtil.destination ? L.GeometryUtil.destination(center, 0, h2) : center;
        const south = L.GeometryUtil && L.GeometryUtil.destination ? L.GeometryUtil.destination(center, 180, h2) : center;
        const east = L.GeometryUtil && L.GeometryUtil.destination ? L.GeometryUtil.destination(center, 90, w2) : center;
        const west = L.GeometryUtil && L.GeometryUtil.destination ? L.GeometryUtil.destination(center, 270, w2) : center;
        const sw = L.latLng(south.lat, west.lng);
        const ne = L.latLng(north.lat, east.lng);
        const layer = L.rectangle(L.latLngBounds(sw, ne), Object.assign({ fill: false }, baseOpts));
        out.push(layer);
      }
    } catch (_) {}
  });
  out.forEach(l => { try { if (l && l.options) l.options.interactive = false; } catch (_) {} });
  return out;
}

function attachCompositeBehavior(marker, typeKey) {
  try {
    if (!marker || marker.__squadCompositeBound) return;
    marker.__squadCompositeBound = true;
    marker.__squadComposite = { type: typeKey };

    const addChildren = () => {
      try {
        if (!marker._map) return;
        const center = marker.getLatLng();
        const layers = buildChildLayers(center, typeKey);
        marker.__squadChildLayers = layers;
        layers.forEach(l => { try { l.addTo(marker._map); } catch (_) {} });
      } catch (_) {}
    };
    const removeChildren = () => {
      try { (marker.__squadChildLayers || []).forEach(l => { try { l.remove(); } catch (_) {} }); } catch (_) {}
      marker.__squadChildLayers = [];
    };
    const refreshChildren = () => { try { removeChildren(); addChildren(); } catch (_) {} };

    marker.on && marker.on('add', addChildren);
    marker.on && marker.on('remove', removeChildren);
    marker.on && marker.on('move', refreshChildren);

    marker.__squadRefreshChildren = refreshChildren;
  } catch (_) {}
}

function createCompositeMarker(typeKey, latlng) {
  const spec = TYPES[typeKey];
  if (!spec) return null;
  const icon = spec.iconOnMap ? faDivIcon(spec.icon, spec.color) : invisibleAnchorIcon();
  const m = L.marker(latlng, { icon });
  m.__faIconName = sanitizeFaIcon(spec.icon);
  m.__faColor = spec.color;
  m.__squadFixedIcon = true;
  m.__squadNoRadial = true; // skip marker radial on create
  attachCompositeBehavior(m, typeKey);
  return m;
}

function ensureToolbarButtons() {
  const bars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
  if (!bars || !bars.length) return false;
  const targetBar = bars[0];
  if (!targetBar) return false;
  let wrap = document.getElementById('squadmaps-squad-buttons');
  const exists = !!wrap;
  if (!wrap) {
    ensureFA();
    wrap = document.createElement('div');
    wrap.id = 'squadmaps-squad-buttons';
    Object.assign(wrap.style, { display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap', pointerEvents: 'auto' });

    if (!document.getElementById('squadmaps-squad-buttons-css')) {
      const st = document.createElement('style'); st.id = 'squadmaps-squad-buttons-css';
      st.textContent = `#squadmaps-squad-buttons{pointer-events:auto!important}
#squadmaps-squad-buttons a{width:30px;height:30px;display:block;background:#171718;border:1px solid #2a2a2b;box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset;color:#fff;text-decoration:none;pointer-events:auto}
#squadmaps-squad-buttons a:hover{filter:brightness(1.1)}
#squadmaps-squad-buttons a.active{outline:2px solid #3b82f6}
#squadmaps-squad-buttons i{display:block;line-height:30px;text-align:center;font-size:14px;pointer-events:none}`;
      document.head.appendChild(st);
    }

    const setActive = (el) => {
      try { wrap.querySelectorAll('a').forEach(x => x.classList.remove('active')); } catch (_) {}
      if (el) el.classList.add('active');
    };

    const addBtn = (key, spec) => {
      const a = document.createElement('a'); a.href = '#'; a.title = key.charAt(0).toUpperCase() + key.slice(1);
      const iconName = sanitizeFaIcon(spec.icon);
      a.innerHTML = `<i class="fa-solid fa-${iconName}"></i>`;
      try { a.style.borderColor = spec.color; } catch (_) {}
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startPlacement(key); setActive(a); });
      wrap.appendChild(a);
    };

    Object.entries(TYPES).forEach(([k, v]) => addBtn(k, v));
  }

  // Always move wrap to end so it stays below any buttons added earlier (like Broadcast)
  try { targetBar.appendChild(wrap); } catch (_) {}
  return true;
}

function startPlacement(typeKey) {
  cancelPlacement();
  const map = (typeof window !== 'undefined' && window.squadMap) || null;
  if (!map || !window.L) return;

  const onMapClick = (ev) => {
    try {
      const latlng = ev && ev.latlng; if (!latlng) return;
      const marker = createCompositeMarker(typeKey, latlng);
      if (!marker) return;
      try { map.fire && map.fire('draw:created', { layerType: 'marker', layer: marker }); } catch (_) {}
    } catch (_) {
    } finally {
      cancelPlacement();
    }
  };

  const onCancel = (ev) => { try { ev && ev.preventDefault && ev.preventDefault(); } catch (_) {} cancelPlacement(); };

  map._container && (map._container.style.cursor = 'crosshair');
  map.on && map.on('click', onMapClick, true);
  map.on && map.on('contextmenu', onCancel, true);
  document.addEventListener('keydown', onEscCancel, true);
  __activePlacement = { typeKey, onMapClick, onCancel };
}

function onEscCancel(ev) {
  try { if (ev && ev.key === 'Escape') { ev.preventDefault(); cancelPlacement(); } } catch (_) {}
}

function cancelPlacement() {
  const map = (typeof window !== 'undefined' && window.squadMap) || null;
  if (__activePlacement && map) {
    try { map.off && map.off('click', __activePlacement.onMapClick, true); } catch (_) {}
    try { map.off && map.off('contextmenu', __activePlacement.onCancel, true); } catch (_) {}
  }
  try { document.removeEventListener('keydown', onEscCancel, true); } catch (_) {}
  try { if (map && map._container) map._container.style.cursor = ''; } catch (_) {}
  __activePlacement = null;
}

function isActiveMapPath() {
  try { const p = (window.location && (window.location.pathname||'')) || ''; return p.startsWith('/map'); } catch(_) { return false; }
}

export function initSquadMarkers() {
  let tries = 0;
  function start() {
    if (!isActiveMapPath()) return false;
    if (!window || !window.L || !window.squadMap || !(window.squadMap instanceof L.Map)) return false;
    if (ensureToolbarButtons()) return true;
    return false;
  }

  start();

  if (!__initOnce) {
    try { window.addEventListener('squadmaps:drawToolbarReady', () => { try { start(); } catch (_) {} }); } catch (_) {}
    __initOnce = true;
  }

  if (!__uiPollTimer) {
    __uiPollTimer = setInterval(() => { tries++; if (start()) { clearInterval(__uiPollTimer); __uiPollTimer = null; } if (tries > 120) { clearInterval(__uiPollTimer); __uiPollTimer = null; } }, 250);
  }

  try {
    if (typeof window !== 'undefined') {
      window.__squadCreateCompositeMarker = (typeKey, latlng) => createCompositeMarker(typeKey, latlng);
    }
  } catch (_) {}
}

try {
  window.__squadRefreshAllCompositeChildren = function() {
    try {
      const map = (typeof window !== 'undefined' && window.squadMap) || null;
      const group = map && map.__squadmapsDrawnItems;
      if (!map || !group || !group.eachLayer) return;
      group.eachLayer(l => { try { if (l && l.__squadRefreshChildren) l.__squadRefreshChildren(); } catch (_) {} });
    } catch (_) {}
  };
} catch (_) {}
