let __rcInitOnce = false;
let __rcPatched = false;

function tryExitMassEditDelete() {
  try {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map) return false;
    const root = map._container || document;
    // 1) Try clicking the visible Save button
    try {
      let btn = (root && root.querySelector && (root.querySelector('.leaflet-draw-actions .leaflet-draw-edit-save')
        || root.querySelector('.leaflet-draw-actions a.leaflet-draw-edit-save')
        || root.querySelector('[class*="leaflet-draw-edit-save"]')));
      if (!btn && typeof document !== 'undefined') {
        btn = document.querySelector('.leaflet-draw-actions .leaflet-draw-edit-save')
          || document.querySelector('[class*="leaflet-draw-edit-save"]');
      }
      if (btn) {
        try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; } catch(_) {}
        try { btn.click(); return true; } catch(_) {}
      }
    } catch(_) {}

    // 2) Fallback to the edit toolbar API
    try {
      const ctrl = map.__squadmapsDrawControl || null;
      const editTb = ctrl && ctrl._toolbars && (ctrl._toolbars.edit || null);
      if (!editTb) return false;
      let acted = false;
      try { if (typeof editTb._save === 'function') { editTb._save(); acted = true; } } catch(_) {}
      // Disable to fully exit the mode
      try {
        if (typeof editTb.disable === 'function') editTb.disable();
        else if (editTb._activeMode && editTb._activeMode.handler && typeof editTb._activeMode.handler.disable === 'function') {
          editTb._activeMode.handler.disable();
        }
      } catch(_) {}
      return acted;
    } catch(_) { return false; }
  } catch(_) { return false; }
}

function isMassEditDeleteActive() {
  try {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map) return false;
    const ctrl = map.__squadmapsDrawControl || null;
    const editTb = ctrl && ctrl._toolbars && (ctrl._toolbars.edit || null);
    // If the edit toolbar has an active mode (edit or remove), treat as mass mode active
    return !!(editTb && editTb._activeMode);
  } catch(_) { return false; }
}

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
          try { window.__squadActiveDrawHandler = this; } catch (_) {}
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

function getActiveHandler() {
  try {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    const tb = map && map._toolbars && map._toolbars.draw;
    const active = tb && tb._activeMode && tb._activeMode.handler;
    return active || window.__squadActiveDrawHandler || null;
  } catch (_) { return window.__squadActiveDrawHandler || null; }
}

function tryFinish(handler) {
  try {
    if (!handler) return false;
    if (typeof handler._finishShape === 'function') { handler._finishShape(); try { handler.disable && handler.disable(); } catch(_) {} return true; }
    if (typeof handler.completeShape === 'function') { handler.completeShape(); try { handler.disable && handler.disable(); } catch(_) {} return true; }
    if (typeof handler._completeShape === 'function') { handler._completeShape(); try { handler.disable && handler.disable(); } catch(_) {} return true; }
    if (typeof handler._endShape === 'function') { handler._endShape(); try { handler.disable && handler.disable(); } catch(_) {} return true; }
    return false;
  } catch (_) { try { handler && handler.disable && handler.disable(); } catch(__) {} return true; }
}

function collectLatLngsFromHandler(h, need) {
  try {
    let latlngs = [];
    if (h && h._poly && typeof h._poly.getLatLngs === 'function') {
      const v = h._poly.getLatLngs();
      latlngs = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : [];
    }
    if ((!Array.isArray(latlngs) || latlngs.length < (need || 2)) && Array.isArray(h && h._markers)) {
      const mpts = h._markers.map(m => m && m.getLatLng && m.getLatLng()).filter(Boolean);
      if (mpts.length >= (need || 2)) latlngs = mpts;
    }
    return (latlngs || []).filter(Boolean);
  } catch (_) { return []; }
}

function rearmContinuousIfIdle(typeHint) {
  try {
    if (!window.__squadContinuousMode) return;
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map) return;
    // Give draw:created handler a moment to rearm itself first
    setTimeout(() => {
      try {
        // If something is already active, skip
        const active = getActiveHandler();
        if (active) return;
        const ctrl = map.__squadmapsDrawControl;
        if (!ctrl) return;
        const drawTb = (ctrl._toolbars && (ctrl._toolbars.draw || ctrl._toolbars.edit)) || ctrl._toolbar || null;
        const modes = drawTb && drawTb._modes;
        if (!modes) return;
        const type = typeHint || null;
        const found = type ? Object.values(modes).find(m => m && m.handler && m.handler.type === type) : null;
        const handler = found && found.handler;
        if (handler && typeof handler.enable === 'function') {
          try { handler.enable(); } catch (_) {}
          return;
        }
        const button = found && found.button;
        if (button && typeof button.dispatchEvent === 'function') {
          try { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
        }
      } catch (_) {}
    }, 180);
  } catch (_) {}
}

function finishOrCancelActiveDraw(domEvent) {
  try {
    const h = getActiveHandler();
    if (!h) {
      // If no active draw tool, check for mass edit/delete and try to exit
      if (isMassEditDeleteActive()) {
        tryExitMassEditDelete();
        return true;
      }
      return false;
    }
    const t = String(h.type || '').toLowerCase();
    const isPolyline = /polyline/.test(t);
    const isPolygon = /polygon/.test(t);
    const isRect = /rectangle/.test(t);
    const isCircle = /circle/.test(t) && !/circlemarker/.test(t);
    const isMarker = /marker/.test(t) && !/circlemarker/.test(t);

    // Always suppress the native menu when we're acting on a draw tool
    try { if (domEvent) { domEvent.preventDefault(); domEvent.stopPropagation(); } } catch (_) {}

    if (isMarker) {
      try { h.disable && h.disable(); } catch (_) {}
      return true;
    }

    if (isPolyline || isPolygon) {
      const pts = Array.isArray(h._markers) ? h._markers.length : 0;
      const need = isPolygon ? 3 : 2;
      if (pts === 0) { // cancel empty tool
        try { h.disable && h.disable(); } catch (_) {}
        return true;
      }
      if (pts >= need) {
        // First try plugin-provided finish hooks
        if (tryFinish(h)) { try { rearmContinuousIfIdle(isPolygon ? 'polygon' : 'polyline'); } catch(_){} return true; }

        // Next, try to simulate the user action that finishes the shape
        try {
          if (isPolygon && h._markers && h._markers[0] && typeof h._markers[0].fire === 'function') {
            h._markers[0].fire('click');
            try { rearmContinuousIfIdle('polygon'); } catch(_){}
            return true;
          }
        } catch (_) {}
        try {
          if (isPolyline && h._markers && h._markers[pts - 1]) {
            const last = h._markers[pts - 1];
            // Try both dblclick and click on the last marker
            if (typeof last.fire === 'function') {
              last.fire('dblclick');
              last.fire('click');
              try { rearmContinuousIfIdle('polyline'); } catch(_){}
              return true;
            }
          }
        } catch (_) {}

        // Robust fallback: build the final layer and use plugin events/cleanup if available
        try {
          const map = h._map || (typeof window !== 'undefined' && window.squadMap) || null;
          if (map && window.L) {
            const latlngs = collectLatLngsFromHandler(h, need);
            if (latlngs.length >= need) {
              const opts = (h.options && h.options.shapeOptions) || (h._poly && h._poly.options) || {};
              const layer = isPolygon ? L.polygon(latlngs, Object.assign({ fill: true }, opts)) : L.polyline(latlngs, opts);

              // Prefer the plugin's own created event helper for proper integration
              let createdFired = false;
              try {
                if (typeof h._fireCreatedEvent === 'function') {
                  h._fireCreatedEvent(layer);
                  createdFired = true;
                }
              } catch (_) {}

              if (!createdFired) {
                try { map.fire && map.fire('draw:created', { layerType: isPolygon ? 'polygon' : 'polyline', layer }); } catch (_) {}
              }

              // Clean up any transient state so continuous mode can re-arm cleanly
              try { if (typeof h._cleanUpShape === 'function') h._cleanUpShape(); } catch (_) {}
              try { if (typeof h._clearGuides === 'function') h._clearGuides(); } catch (_) {}
              try { if (typeof h._updateFinishHandler === 'function') h._updateFinishHandler(); } catch (_) {}

              try { h.disable && h.disable(); } catch (_) {}
              try { rearmContinuousIfIdle(isPolygon ? 'polygon' : 'polyline'); } catch(_){}
              return true;
            }
          }
        } catch (_) {}

        // If nothing worked, at least disable to cancel
        try { h.disable && h.disable(); } catch (_) {}
        try { rearmContinuousIfIdle(isPolygon ? 'polygon' : 'polyline'); } catch(_){}
        return true;
      }
      // not enough points: cancel
      try { h.disable && h.disable(); } catch (_) {}
      try { rearmContinuousIfIdle(isPolygon ? 'polygon' : 'polyline'); } catch(_){}
      return true;
    }

    if (isRect || isCircle) {
      // If drag not started yet, cancel; otherwise just suppress context menu
      let notStarted = false;
      try { if (typeof h._isCurrentlyDrawing === 'function') notStarted = !h._isCurrentlyDrawing(); } catch (_) {}
      if (!notStarted) { try { notStarted = !h._shape; } catch (_) { notStarted = true; } }
      if (notStarted) { try { h.disable && h.disable(); } catch (_) {} }
      return true;
    }
    return false;
  } catch (_) { return false; }
}

function isEventInsideMap(e) {
  try {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    const cont = map && map._container;
    if (!cont || !e) return false;
    if (cont.contains(e.target)) return true;
    if (e.clientX != null && e.clientY != null) {
      const r = cont.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }
    return false;
  } catch (_) { return false; }
}

function attachContainerListeners(map) {
  try {
    const cont = map && map._container;
    if (!cont || cont.__rcListenersAttached) return;
    cont.__rcListenersAttached = true;
    const down = (e) => { try {
      if (e.button===2 && isEventInsideMap(e)) {
        // First finish/cancel active draw, or exit mass edit/delete
        const acted = finishOrCancelActiveDraw(e) || (isMassEditDeleteActive() && tryExitMassEditDelete());
        if (acted){ e.preventDefault(); e.stopPropagation(); }
      }
    } catch(_){} };
    const up = (e) => { try { if (!isEventInsideMap(e)) return; if (e.button===2) { e.preventDefault(); e.stopPropagation(); } } catch(_){} };
    // No click suppression after right-click; allow normal clicks to pass through
    const ctx = (e) => { try { if (isEventInsideMap(e)) { e.preventDefault(); e.stopPropagation(); finishOrCancelActiveDraw(e) || (isMassEditDeleteActive() && tryExitMassEditDelete()); } } catch(_){} };
    cont.addEventListener('pointerdown', down, true);
    cont.addEventListener('mousedown', down, true);
    cont.addEventListener('pointerup', up, true);
    cont.addEventListener('mouseup', up, true);
    cont.addEventListener('contextmenu', ctx, true);
  } catch (_) {}
}

export function initRightClick() {
  if (__rcInitOnce) return;
  __rcInitOnce = true;
  try { if (!patchActiveDrawTracking()) {
    let tries = 0;
    const t = setInterval(() => { tries++; if (patchActiveDrawTracking()) { clearInterval(t); } if (tries > 120) clearInterval(t); }, 250);
  } } catch (_) {}

  // Also attach container listeners for the current map if present, and for future maps via init hook
  try {
    if (window && window.squadMap) attachContainerListeners(window.squadMap);
    if (window && window.L && L.Map && !L.Map.__rcContainerHooked) {
      L.Map.addInitHook(function(){ try { attachContainerListeners(this); } catch(_) {} });
      L.Map.__rcContainerHooked = true;
    }
  } catch(_){ }

  // Suppress native context menu inside map; also use it to finish/cancel active draw
  try {
    window.addEventListener('contextmenu', (e) => {
      try {
        if (isEventInsideMap(e)) {
          // Always block the native context menu inside the map
          try { e.preventDefault(); e.stopPropagation(); } catch(_) {}
          // Then try to finish/cancel any active draw tool or exit mass modes
          finishOrCancelActiveDraw(e) || (isMassEditDeleteActive() && tryExitMassEditDelete());
          return false;
        }
      } catch (_) {}
    }, true);
  } catch (_) {}

  // Early interception on right mouse down to avoid stray vertex inserts
  try {
    const handleDown = (e) => {
      try {
        if (e.button !== 2) return; // right button only
        if (isEventInsideMap(e)) {
          const acted = finishOrCancelActiveDraw(e) || (isMassEditDeleteActive() && tryExitMassEditDelete());
          if (acted) { e.preventDefault(); e.stopPropagation(); return false; }
        }
      } catch (_) {}
    };
    window.addEventListener('mousedown', handleDown, true);
    window.addEventListener('pointerdown', handleDown, true);

    // Only block the right-button release; do not suppress subsequent left-clicks
    const handleUp = (e) => {
      try {
        if (!isEventInsideMap(e)) return;
        if (e.button === 2) { e.preventDefault(); e.stopPropagation(); }
      } catch (_) {}
    };
    window.addEventListener('mouseup', handleUp, true);
    window.addEventListener('pointerup', handleUp, true);
  } catch (_) {}
}
