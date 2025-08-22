// filepath: src/userscript/rightclick.js
let __rcInitOnce = false;
let __rcPatched = false;

function patchActiveDrawTracking() {
  try {
    if (!window || !window.L || !L.Draw) return false;
    const ctors = [L.Draw.Polyline, L.Draw.Polygon, L.Draw.Rectangle, L.Draw.Circle, L.Draw.Marker].filter(Boolean);
    if (!ctors.length) return false;
    ctors.forEach((Ctor) => {
      const p = Ctor && Ctor.prototype;
      if (!p) return;
      if (typeof p.enable === 'function' && !p.__squadEnablePatched) {
        const orig = p.enable;
        p.enable = function() {
          try { window.__squadActiveDrawHandler = this; this.__squadActiveType = (this.type || this.TYPE || (Ctor && Ctor.name && Ctor.name.toLowerCase()) || 'draw'); } catch (_) {}
          return orig.apply(this, arguments);
        };
        p.__squadEnablePatched = true;
      }
      if (typeof p.disable === 'function' && !p.__squadDisablePatched) {
        const origD = p.disable;
        p.disable = function() {
          try { if (window.__squadActiveDrawHandler === this) window.__squadActiveDrawHandler = null; } catch (_) {}
          return origD.apply(this, arguments);
        };
        p.__squadDisablePatched = true;
      }
    });
    __rcPatched = true;
    return true;
  } catch (_) { return false; }
}

function finishOrCancelActiveDraw() {
  try {
    const h = window.__squadActiveDrawHandler;
    if (!h) return false;
    const isPolyline = (window.L && L.Draw && L.Draw.Polyline && h instanceof L.Draw.Polyline);
    const isPolygon = (window.L && L.Draw && L.Draw.Polygon && h instanceof L.Draw.Polygon);
    const isRect = (window.L && L.Draw && L.Draw.Rectangle && h instanceof L.Draw.Rectangle);
    const isCircle = (window.L && L.Draw && L.Draw.Circle && h instanceof L.Draw.Circle);
    if (isPolyline || isPolygon) {
      if (typeof h._finishShape === 'function') { h._finishShape(); return true; }
      if (typeof h.completeShape === 'function') { h.completeShape(); return true; }
      return false;
    }
    if (isRect || isCircle) {
      // If drag not started, cancel the tool to avoid leaving a ghost state
      // Heuristic: internal _isCurrentlyDrawing() or lack of _shape
      let notStarted = false;
      try { if (typeof h._isCurrentlyDrawing === 'function') notStarted = !h._isCurrentlyDrawing(); } catch (_) {}
      if (!notStarted) { try { notStarted = !h._shape; } catch (_) { notStarted = true; } }
      if (notStarted && typeof h.disable === 'function') { h.disable(); return true; }
      return true; // if drawing, just suppress context menu
    }
    return false;
  } catch (_) { return false; }
}

export function initRightClick() {
  if (__rcInitOnce) return;
  __rcInitOnce = true;
  try { if (!patchActiveDrawTracking()) {
    let tries = 0;
    const t = setInterval(() => { tries++; if (patchActiveDrawTracking()) { clearInterval(t); } if (tries > 120) clearInterval(t); }, 250);
  } } catch (_) {}

  // Suppress native context menu inside map; also use it to finish/cancel active draw
  try {
    window.addEventListener('contextmenu', (e) => {
      try {
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (map && map._container && map._container.contains(e.target)) {
          e.preventDefault();
          e.stopPropagation();
          finishOrCancelActiveDraw();
          return false;
        }
      } catch (_) {}
    }, true);
  } catch (_) {}

  // Early interception on right mouse down to avoid stray vertex inserts
  try {
    window.addEventListener('mousedown', (e) => {
      try {
        if (e.button !== 2) return; // right button only
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (map && map._container && map._container.contains(e.target)) {
          const acted = finishOrCancelActiveDraw();
          if (acted) { e.preventDefault(); e.stopPropagation(); return false; }
        }
      } catch (_) {}
    }, true);
  } catch (_) {}
}
