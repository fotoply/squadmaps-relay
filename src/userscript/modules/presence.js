// filepath: src/userscript/modules/presence.js
// Presence module: username panel, follow user, and live cursors.
// initPresence({ applyRemoteView }) returns handlers and a setEmit(emit) to wire sockets later.

let __presenceInitOnce = false;
const USERNAME_KEY = 'squadmapsUsername';
const FOLLOW_KEY = 'squadmapsFollowUser';

let mySocketId = null;
let followingUserId = null;
let presenceUsers = {}; // id -> { id, name, tool, cursor, view, color, marker }
let presenceLayer = null; // L.LayerGroup
let presencePanelEl = null; // container DOM
let presenceHandlersAttached = false;
let __emit = { presenceUpdate: (_d)=>{}, usernameSet: (_p)=>{} };
let __applyRemoteView = (_v)=>{};
let __isApplyingFn = () => false;
let __suppressNextViewEmitUntil = 0; // suppress self view emit after programmatic follow moves

function ensurePresenceLayer() {
  const map = (typeof window !== 'undefined' && window.squadMap) || null;
  if (!map) return;
  if (presenceLayer && presenceLayer._map === map) return;
  try { if (presenceLayer && presenceLayer._map && presenceLayer._map !== map) presenceLayer.remove(); } catch (_) {}
  try { presenceLayer = L.layerGroup().addTo(map); } catch (_) {}
}

function colorForUser(id, name) {
  const s = String(id || name || 'u');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 85%, 55%)`;
}

function shortId(id) {
  if (!id) return 'anon';
  const s = String(id);
  return s.length > 6 ? s.slice(0, 3) + '…' + s.slice(-2) : s;
}

function toolLabel(t) {
  if (!t) return '';
  const m = { polygon: 'Polygon', polyline: 'Polyline', rectangle: 'Rectangle', circle: 'Circle', marker: 'Marker', edit: 'Edit', delete: 'Delete' };
  return m[t] || t;
}

function animateMarkerTo(marker, targetLatLng, durationMs) {
  try { if (!marker || !targetLatLng) return; } catch (_) { return; }
  const from = marker.getLatLng();
  const to = L.latLng(targetLatLng);
  const dur = Math.max(60, Number(durationMs) || 120);
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lng)) { try { marker.setLatLng(to); } catch (_) {} return; }
  const dLat = to.lat - from.lat; const dLng = to.lng - from.lng;
  if (Math.abs(dLat) + Math.abs(dLng) < 1e-10) return;
  if (marker.__animRaf) { cancelAnimationFrame(marker.__animRaf); marker.__animRaf = null; }
  const start = performance.now();
  function step(ts) {
    const t = Math.min(1, (ts - start) / dur);
    const lat = from.lat + dLat * t; const lng = from.lng + dLng * t;
    try { marker.setLatLng([lat, lng]); } catch (_) {}
    if (t < 1) marker.__animRaf = requestAnimationFrame(step); else marker.__animRaf = null;
  }
  marker.__animRaf = requestAnimationFrame(step);
}

function userDisplayColor(u) {
  // Prefer explicit user color from presence; fallback to hash by id/name
  if (u && typeof u.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(u.color)) {
    const c = (u.color[0] === '#' ? u.color : ('#' + u.color));
    return c.toLowerCase();
  }
  return colorForUser(u && u.id, u && u.name);
}

function updatePresenceCursorMarker(u) {
  const map = (typeof window !== 'undefined' && window.squadMap) || null;
  if (!map || !presenceLayer || !u) return;
  if (mySocketId && u.id === mySocketId) {
    if (u.marker) { try { presenceLayer.removeLayer(u.marker); } catch (_) {} u.marker = null; }
    return;
  }
  if (!u.cursor || !Number.isFinite(u.cursor.lat) || !Number.isFinite(u.cursor.lng)) {
    if (u.marker) { try { presenceLayer.removeLayer(u.marker); } catch (_) {} u.marker = null; }
    return;
  }
  const latlng = L.latLng(u.cursor.lat, u.cursor.lng);
  const col = userDisplayColor(u);
  if (!u.marker) {
    const m = L.circleMarker(latlng, { radius: 5, color: col, weight: 2, fillColor: col, fillOpacity: 0.7, opacity: 1 });
    try { m.bindTooltip(() => `${u.name || shortId(u.id)}${u.tool ? ` · ${toolLabel(u.tool)}` : ''}`, { permanent: true, direction: 'top', offset: [0, -10], className: 'squadmaps-presence-tip' }); } catch (_) {}
    presenceLayer.addLayer(m);
    u.marker = m;
  } else {
    try { u.marker.setStyle({ color: col, fillColor: col }); } catch (_) {}
    try { u.marker.setTooltipContent(`${u.name || shortId(u.id)}${u.tool ? ` · ${toolLabel(u.tool)}` : ''}`); } catch (_) {}
    try { animateMarkerTo(u.marker, latlng, 120); } catch (_) { try { u.marker.setLatLng(latlng); } catch (__) {} }
  }
}

function buildPresenceUI() {
  const map = (typeof window !== 'undefined' && window.squadMap) || null;
  if (!map) return;
  if (presencePanelEl) {
    try {
      const parent = (map && map._container) || document.body;
      if (presencePanelEl.parentElement !== parent) parent.appendChild(presencePanelEl);
      presencePanelEl.style.position = (parent === document.body) ? 'fixed' : 'absolute';
      presencePanelEl.style.bottom = '8px';
      presencePanelEl.style.right = '8px';
      if (typeof window.updatePresencePanelPosition === 'function') window.updatePresencePanelPosition();
    } catch (_) {}
    return;
  }
  const wrap = document.createElement('div');
  wrap.id = 'squadmaps-presence-panel';
  const parent = (map && map._container) || document.body;
  const inMap = (parent !== document.body);
  Object.assign(wrap.style, { position: inMap ? 'absolute' : 'fixed', right: '8px', bottom: '8px', zIndex: 10000, background: '#171718', color: '#fff', border: '1px solid #2a2a2b', borderRadius: '6px', boxShadow: '0 2px 8px rgba(0,0,0,0.4)', width: '220px', font: '12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' });
  wrap.innerHTML = `
<div style="padding:8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #2a2a2b;">
  <span style="white-space:nowrap">Name</span>
  <input id="squadmaps-username" type="text" placeholder="Your name" style="flex:1; min-width:0; background:#0f0f10; color:#fff; border:1px solid #2a2a2b; border-radius:4px; padding:4px 6px;" maxlength="32"/>
</div>
<div id="squadmaps-userlist" style="max-height:180px; overflow:auto; padding:6px 8px;"></div>`;
  parent.appendChild(wrap);
  presencePanelEl = wrap;

  function updatePresencePanelPosition() {
    try {
      if (!presencePanelEl) return;
      const mapContainer = window.squadMap && window.squadMap._container;
      presencePanelEl.style.bottom = '8px';
      if (mapContainer && presencePanelEl.parentElement === mapContainer) {
        const br = mapContainer.querySelector('.leaflet-control-container .leaflet-bottom.leaflet-right');
        let rightPad = 8;
        if (br) { const w = br.offsetWidth || 0; rightPad = Math.max(8, Math.round(w) + 8); }
        presencePanelEl.style.right = rightPad + 'px';
      } else { presencePanelEl.style.right = '8px'; }
    } catch (_) {}
  }
  try { window.updatePresencePanelPosition = updatePresencePanelPosition; } catch (_) {}
  try {
    const mapContainer = window.squadMap && window.squadMap._container;
    if (mapContainer) {
      const br = mapContainer.querySelector('.leaflet-control-container .leaflet-bottom.leaflet-right');
      if (br && 'ResizeObserver' in window) { const ro = new ResizeObserver(() => updatePresencePanelPosition()); ro.observe(br); presencePanelEl.__ro = ro; }
      try { window.squadMap.on && window.squadMap.on('resize', updatePresencePanelPosition); } catch (_) {}
    }
    window.addEventListener('resize', updatePresencePanelPosition);
  } catch (_) {}

  const input = wrap.querySelector('#squadmaps-username');
  try { const saved = localStorage.getItem(USERNAME_KEY); if (saved) input.value = saved; } catch (_) {}
  try { const savedFollow = localStorage.getItem(FOLLOW_KEY) || ''; followingUserId = savedFollow || null; } catch (_) {}
  input.addEventListener('change', () => {
    const name = (input.value || '').trim().slice(0, 32);
    try { localStorage.setItem(USERNAME_KEY, name); } catch (_) {}
    __emit.usernameSet && __emit.usernameSet({ name });
    if (mySocketId && presenceUsers[mySocketId]) { presenceUsers[mySocketId].name = name || null; renderUserList(); }
  });
  if (!document.getElementById('squadmaps-presence-css')) {
    const st = document.createElement('style'); st.id = 'squadmaps-presence-css';
    st.textContent = `.squadmaps-presence-tip{background:#000c;border:none;color:#fff;}
#squadmaps-presence-panel .user{display:flex; align-items:center; gap:6px; padding:3px 0;}
#squadmaps-presence-panel .user .dot{width:8px;height:8px;border-radius:50%;}
#squadmaps-presence-panel .user .name{flex:1; min-width:0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;}
#squadmaps-presence-panel input[type=radio]{accent-color:#3b82f6;}`;
    document.head.appendChild(st);
  }
  renderUserList();
  try { updatePresencePanelPosition(); } catch (_) {}
}

function renderUserList() {
  if (!presencePanelEl) return;
  const list = presencePanelEl.querySelector('#squadmaps-userlist');
  if (!list) return;
  const entries = Object.values(presenceUsers);
  entries.sort((a,b)=>{ const an=(a.name||'').toLowerCase(); const bn=(b.name||'').toLowerCase(); return (an<bn?-1:an>bn?1: (a.id<b.id?-1:1)); });
  const radioName = 'squadmaps-follow';
  const noneChecked = !followingUserId;
  let html = `<label class="user" title="Stop following">
  <input type="radio" name="${radioName}" value="" ${noneChecked ? 'checked' : ''} />
  <span class="dot" style="background:#555"></span>
  <span class="name">None</span>
</label>`;
  entries.forEach(u => {
    const isSelf = (u.id === mySocketId);
    const col = userDisplayColor(u);
    const checked = followingUserId === u.id ? 'checked' : '';
    const disabled = isSelf ? 'disabled' : '';
    const safeName = (u.name || shortId(u.id)).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    html += `<label class="user" data-id="${u.id}">
  <input type="radio" name="${radioName}" value="${u.id}" ${checked} ${disabled} />
  <span class="dot" style="background:${col}"></span>
  <span class="name" title="${u.name || shortId(u.id)}">${safeName}</span>
  <span class="tool" style="opacity:.8">${u.tool ? toolLabel(u.tool) : ''}</span>
</label>`;
  });
  list.innerHTML = html;
  list.querySelectorAll('input[type=radio]').forEach(inp => {
    inp.addEventListener('change', e => {
      const val = e.target.value || '';
      followingUserId = val || null;
      try { localStorage.setItem(FOLLOW_KEY, followingUserId || ''); } catch (_) {}
      if (followingUserId && presenceUsers[followingUserId]) {
        const u = presenceUsers[followingUserId];
        console.log('[presence] follow change apply view for', followingUserId, u.view);
        applyFollowTarget(u);
      } else {
        console.log('[presence] follow cleared');
      }
    });
  });
}

function applyFollowTarget(u) {
  try {
    if (!u || !u.view) return; // only apply if an explicit view exists
    __suppressNextViewEmitUntil = Date.now() + 100;
    __applyRemoteView && __applyRemoteView(u.view);
  } catch (_) {}
}

function upsertPresenceUser(u) {
  if (!u || !u.id) return;
  const prev = presenceUsers[u.id] || { id: u.id };
  const merged = Object.assign(prev, u);
  presenceUsers[u.id] = merged;
  ensurePresenceLayer();
  updatePresenceCursorMarker(merged);
  renderUserList();
}

function removePresenceUser(id) {
  const u = presenceUsers[id];
  if (!u) return;
  if (u.marker) { try { presenceLayer.removeLayer(u.marker); } catch (_) {} }
  delete presenceUsers[id];
  if (followingUserId === id) { followingUserId = null; try { localStorage.setItem(FOLLOW_KEY, ''); } catch (_) {} }
  renderUserList();
}

function attachPresenceEmitters() {
  if (presenceHandlersAttached || !window || !window.squadMap) return;
  const map = window.squadMap;
  presenceHandlersAttached = true;
  console.log('[presence] attaching emitters');
  let lastCursorEmit = 0;
  map.on('mousemove', (e) => {
    const now = Date.now();
    if (now - lastCursorEmit < 90) return;
    lastCursorEmit = now;
    if (!e || !e.latlng) return;
    __emit.presenceUpdate && __emit.presenceUpdate({ cursor: { lat: e.latlng.lat, lng: e.latlng.lng } });
    if (mySocketId) upsertPresenceUser({ id: mySocketId, cursor: { lat: e.latlng.lat, lng: e.latlng.lng } });
    // removed cursor follow fallback to avoid distraction
  });
  map.on('moveend', () => {
    try {
      const now = Date.now();
      if (now < __suppressNextViewEmitUntil) { console.log('[presence] moveend suppressed (follow)'); return; }
      if (__isApplyingFn && __isApplyingFn()) { console.log('[presence] moveend suppressed (applying)'); return; }
      const c = map.getCenter(); const z = map.getZoom();
      console.log('[presence] moveend emit view', c, z);
      __emit.presenceUpdate && __emit.presenceUpdate({ view: { center: { lat: c.lat, lng: c.lng }, zoom: z } });
      if (mySocketId) upsertPresenceUser({ id: mySocketId, view: { center: { lat: c.lat, lng: c.lng }, zoom: z } });
    } catch (_) {}
  });
  map.on('draw:drawstart', (e) => { const t = e && e.layerType; __emit.presenceUpdate && __emit.presenceUpdate({ tool: t || null }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: t || null }); });
  map.on('draw:drawstop', () => { __emit.presenceUpdate && __emit.presenceUpdate({ tool: null }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: null }); });
  map.on('draw:editstart', () => { __emit.presenceUpdate && __emit.presenceUpdate({ tool: 'edit' }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: 'edit' }); });
  map.on('draw:editstop', () => { __emit.presenceUpdate && __emit.presenceUpdate({ tool: null }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: null }); });
  map.on('draw:deletestart', () => { __emit.presenceUpdate && __emit.presenceUpdate({ tool: 'delete' }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: 'delete' }); });
  map.on('draw:deletestop', () => { __emit.presenceUpdate && __emit.presenceUpdate({ tool: null }); if (mySocketId) upsertPresenceUser({ id: mySocketId, tool: null }); });

  // Listen for color changes from the toolbar and broadcast
  try {
    window.addEventListener('squadmaps:userColorChanged', (ev) => {
      try {
        const col = (ev && ev.detail && ev.detail.color) || (window && window.userColor);
        if (!col) return;
        __emit.presenceUpdate && __emit.presenceUpdate({ color: col });
        if (mySocketId) upsertPresenceUser({ id: mySocketId, color: col });
      } catch (_) {}
    });
  } catch (_) {}
}

export function initPresence(deps = {}) {
  if (!__presenceInitOnce) {
    try {
      if (window && window.L && L.Map && !L.Map.__presenceEmitHooked) {
        L.Map.addInitHook(function () { try { attachPresenceEmitters(); buildPresenceUI(); } catch (_) {} });
        L.Map.__presenceEmitHooked = true;
        console.log('[presence] installed map init hook for emitters');
      }
    } catch (_) {}
  }
  if (__presenceInitOnce) return {
    setEmit: (e) => { __emit = Object.assign(__emit, e || {}); if (!presenceHandlersAttached && window && window.squadMap) attachPresenceEmitters(); },
    onConnected: (id) => { mySocketId = id || null; try { if (mySocketId && presenceUsers[mySocketId] && presenceUsers[mySocketId].marker && presenceLayer) { presenceLayer.removeLayer(presenceUsers[mySocketId].marker); presenceUsers[mySocketId].marker = null; } } catch (_) {} },
    onStateInit: (st) => { try { (st?.users || []).forEach(upsertPresenceUser); } catch (_) {} buildPresenceUI(); if (followingUserId && presenceUsers[followingUserId]) applyFollowTarget(presenceUsers[followingUserId]); },
    onUserJoined: (u) => upsertPresenceUser(u),
    onUserLeft: (u) => { if (u && u.id) removePresenceUser(u.id); },
    onUserUpdated: (u) => upsertPresenceUser(u),
    onPresenceUpdate: (delta) => {
      if (!delta || !delta.id) return;
      const u = presenceUsers[delta.id] || { id: delta.id };
      if (delta.tool !== undefined) u.tool = delta.tool;
      if (delta.cursor) u.cursor = delta.cursor;
      if (delta.view) u.view = delta.view;
      if (delta.color) u.color = delta.color;
      upsertPresenceUser(u);
      if (followingUserId && delta.id === followingUserId && delta.view) {
        console.log('[presence] apply remote view from', delta.id, delta.view);
        __suppressNextViewEmitUntil = Date.now() + 100;
        __applyRemoteView && __applyRemoteView(delta.view);
      }
    }
  };
  __applyRemoteView = deps.applyRemoteView || __applyRemoteView;
  __isApplyingFn = deps.isApplying || __isApplyingFn;
  __presenceInitOnce = true;
  buildPresenceUI();
  return {
    setEmit: (e) => { __emit = Object.assign(__emit, e || {}); if (!presenceHandlersAttached && window && window.squadMap) attachPresenceEmitters(); },
    onConnected: (id) => { mySocketId = id || null; try { if (mySocketId && presenceUsers[mySocketId] && presenceUsers[mySocketId].marker && presenceLayer) { presenceLayer.removeLayer(presenceUsers[mySocketId].marker); presenceUsers[mySocketId].marker = null; } } catch (_) {} },
    onStateInit: (st) => { try { (st?.users || []).forEach(upsertPresenceUser); } catch (_) {} buildPresenceUI(); if (followingUserId && presenceUsers[followingUserId]) applyFollowTarget(presenceUsers[followingUserId]); },
    onUserJoined: (u) => upsertPresenceUser(u),
    onUserLeft: (u) => { if (u && u.id) removePresenceUser(u.id); },
    onUserUpdated: (u) => upsertPresenceUser(u),
    onPresenceUpdate: (delta) => { if (!delta || !delta.id) return; const u = presenceUsers[delta.id] || { id: delta.id }; if (delta.tool !== undefined) u.tool = delta.tool; if (delta.cursor) u.cursor = delta.cursor; if (delta.view) u.view = delta.view; if (delta.color) u.color = delta.color; upsertPresenceUser(u); if (followingUserId && delta.id === followingUserId && delta.view) { console.log('[presence] apply remote view from', delta.id, delta.view); __suppressNextViewEmitUntil = Date.now() + 800; __applyRemoteView && __applyRemoteView(delta.view); } }
  };
}
