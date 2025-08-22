// filepath: src/userscript/units.js
// In-game units patch extracted from the legacy Tampermonkey script.
// Applies readableDistance/readableArea scaling and rectangle side lengths in the tooltip.
// Safe to call multiple times; will no-op after first successful application.

let __unitsApplied = false;

function ready() {
  try {
    return !!(window.L && L.Draw && L.GeometryUtil);
  } catch (_) {
    return false;
  }
}

function key() {
  try {
    const u = new URL(location.href);
    return `name=${u.searchParams.get('name') || ''}|layer=${u.searchParams.get('layer') || ''}`;
  } catch (_) {
    return location.pathname + location.search;
  }
}

const STORE = 'squadmapsUnitsKByMapV1';

function loadK() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
    const rec = all[key()];
    if (rec && typeof rec.k === 'number' && rec.k > 0) return rec.k;
  } catch (_) {}
  return 0.01; // default scale: 0.01 meters per Leaflet unit
}

function saveK(k) {
  if (!Number.isFinite(k) || k <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
    all[key()] = { k: Number(k), savedAt: Date.now() };
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch (_) {}
}

function fmtLen(m) {
  if (!(m >= 0)) return '0 m';
  if (m < 1000) return Math.round(m) + ' m';
  const km = m / 1000;
  return (km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)) + ' km';
}

function fmtArea(a) {
  if (!(a >= 0)) return '0 m²';
  if (a < 1e6) return Math.round(a).toLocaleString() + ' m²';
  const km2 = a / 1e6;
  return (km2 < 10 ? km2.toFixed(3) : km2.toFixed(2)) + ' km²';
}

function applyUnits() {
  if (__unitsApplied) return;
  if (!ready()) return;
  const k = loadK();

  // Patch distance/area formatters
  if (!L.GeometryUtil.__origReadableDistance) L.GeometryUtil.__origReadableDistance = L.GeometryUtil.readableDistance;
  if (!L.GeometryUtil.__origReadableArea) L.GeometryUtil.__origReadableArea = L.GeometryUtil.readableArea;
  L.GeometryUtil.readableDistance = function (d) {
    try {
      return fmtLen(Math.max(0, Number(d) * k));
    } catch (_) {
      return L.GeometryUtil.__origReadableDistance.call(this, d, true);
    }
  };
  L.GeometryUtil.readableArea = function (a) {
    try {
      return fmtArea(Math.max(0, Number(a) * k * k));
    } catch (_) {
      return L.GeometryUtil.__origReadableArea.call(this, a, true);
    }
  };

  // Public tiny API
  try {
    window.setInGameUnitsScale = function (newK) {
      saveK(Number(newK));
      __unitsApplied = false; // allow re-apply with new scale
      try { applyUnits(); } catch (_) {}
    };
    window.getInGameUnitsScale = function () { return loadK(); };
  } catch (_) {}

  // Tooltip side length augmentation for rectangles
  try {
    if (L.Draw && L.Draw.Tooltip && !L.Draw.Tooltip.__squadSidePatched) {
      const proto = L.Draw.Tooltip.prototype;
      const origUpdate = proto.updateContent;
      proto.updateContent = function (content) {
        try {
          const h = window.__squadActiveDrawHandler;
          if (h && /rectangle/.test(h.type || '') && h._shape && h._map && typeof h._shape.getBounds === 'function') {
            const b = h._shape.getBounds();
            const nw = b.getNorthWest && b.getNorthWest();
            const se = b.getSouthEast && b.getSouthEast();
            if (nw && se) {
              const map = h._map;
              const widthBase = map.distance(L.latLng(nw.lat, nw.lng), L.latLng(nw.lat, se.lng));
              const heightBase = map.distance(L.latLng(nw.lat, nw.lng), L.latLng(se.lat, nw.lng));
              if (Number.isFinite(widthBase) && Number.isFinite(heightBase)) {
                let wStr, hStr;
                try { wStr = L.GeometryUtil.readableDistance(widthBase); } catch (_) { wStr = fmtLen(Math.max(0, Number(widthBase) * loadK())); }
                try { hStr = L.GeometryUtil.readableDistance(heightBase); } catch (_) { hStr = fmtLen(Math.max(0, Number(heightBase) * loadK())); }
                const baseSub = (content && content.subtext) ? String(content.subtext) : '';
                const prefix = baseSub ? (baseSub + '<br>') : '';
                const appended = prefix + 'Width: ' + wStr + '<br>Height: ' + hStr;
                content = Object.assign({}, content || {}, { subtext: appended });
              }
            }
          }
        } catch (_) {}
        return origUpdate.call(this, content);
      };
      L.Draw.Tooltip.__squadSidePatched = true;
    }
  } catch (_) {}

  // Ensure polygon/rectangle area uses planar area based on current map CRS units
  try {
    if (L.GeometryUtil && !L.GeometryUtil.__squadAreaPatched) {
      if (!L.GeometryUtil.__origGeodesicArea) L.GeometryUtil.__origGeodesicArea = L.GeometryUtil.geodesicArea;
      L.GeometryUtil.geodesicArea = function (latLngs) {
        try {
          const map = window.squadMap;
          if (!map || !map.options || !map.options.crs || typeof map.options.crs.project !== 'function') {
            try { return L.GeometryUtil.__origGeodesicArea.apply(this, arguments); } catch (__) { return 0; }
          }
          const ring = (Array.isArray(latLngs) && Array.isArray(latLngs[0])) ? latLngs[0] : latLngs;
          if (!Array.isArray(ring) || ring.length < 3) return 0;
          const pts = ring.map(ll => map.options.crs.project(ll));
          let sum = 0; const n = pts.length;
          for (let i = 0; i < n; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % n];
            sum += (a.x * b.y - b.x * a.y);
          }
          return Math.abs(sum) * 0.5;
        } catch (_) {
          try { return L.GeometryUtil.__origGeodesicArea.apply(this, arguments); } catch (__) { return 0; }
        }
      };
      L.GeometryUtil.__squadAreaPatched = true;
    }
  } catch (_) {}

  console.log('[units] in-game formatter active, k =', k);
  __unitsApplied = true;
}

export function initUnits() {
  try {
    if (ready()) { applyUnits(); return; }
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (ready()) { clearInterval(t); applyUnits(); }
      if (tries > 120) clearInterval(t);
    }, 200);
  } catch (_) {
    // swallow
  }
}

