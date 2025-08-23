// Draw module: initializes Leaflet.Draw tools, serializes layers, and emits changes via provided callbacks.
// Safe to call multiple times; will no-op if already initialized or if Leaflet/map not ready yet.

let __drawInitOnce = false; // module-level guard
let __progressTimer = null;
let __progressId = null;
let __progressType = null; // 'polyline' | 'polygon'
let __progressLastSig = '';
let __progressCleanupTimer = null;
let __emitRef = null;
let __lastDrawType = null;
let __removeModeActive = false;
let __mapRef = null;
let __mapWatchTimer = null;
let __assetsRequested = false;
let __pointerBlockers = [];
let __toolbarWatchTimer = null;
let __toolbarObserver = null;
let __toolbarEnsureDebounce = null;
let __hookedInitOnce = false;
let __loggedMapScanOnce = false;

// Undo/redo stacks and vars
let __undoStack = [];
let __redoStack = [];
let __undoListenerAdded = false;

let __hoveredLayer = null; // Track currently hovered layer
let __lastMouseLatLng = null; // Track last mouse position over the map
let __mapMouseMoveHandlerAdded = false;
let __activeEditedLayer = null; // Enforce single active edit layer
const __editEmitDebounceMs = 150; // debounce edits to avoid flooding
let __toolbarEditModeActive = false; // Track Leaflet.Draw toolbar edit mode

function __isActiveMapPath() {
    try {
        const p = (window.location && (window.location.pathname || '')) || '';
        // Active map views use '/map' path; selector uses '/' with ?map=...
        return typeof p === 'string' && p.startsWith('/map');
    } catch (_) {
        return false;
    }
}

function __findLayerAtLatLng(latlng) {
    if (!window.squadMap || !window.squadMap.__squadmapsDrawnItems) return null;
    let found = null;
    window.squadMap.__squadmapsDrawnItems.eachLayer(function(layer) {
        if (layer.getBounds && layer.getBounds().contains(latlng)) {
            found = layer;
        } else if (layer.getLatLng && layer.getLatLng().equals && layer.getLatLng().equals(latlng)) {
            found = layer;
        } else if (layer.getLatLng && layer.getLatLng().distanceTo && latlng.distanceTo(layer.getLatLng()) < 10) {
            found = layer;
        }
    });
    return found;
}

function __layerFromEventOrCursor(e) {
    try {
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (!map) return null;
        // Prefer currently hovered layer when available
        if (__hoveredLayer) return __hoveredLayer;
        // If this is a mouse event with coordinates, use that
        if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number') {
            try {
                const point = map.mouseEventToContainerPoint(e);
                const latlng = map.containerPointToLatLng(point);
                return __findLayerAtLatLng(latlng);
            } catch (_) {}
        }
        // Fallback to last recorded mouse position over the map
        if (__lastMouseLatLng) return __findLayerAtLatLng(__lastMouseLatLng);
    } catch (_) {}
    return null;
}

function __addLayerHoverListener(layer) {
    try {
        if (!layer || layer.__squadHoverBound) return;
        layer.__squadHoverBound = true;
        // Mark hovered layer on mouseover/out for precise targeting
        layer.on && layer.on('mouseover', function () {
            try { __hoveredLayer = layer; } catch (_) {}
        });
        layer.on && layer.on('mouseout', function () {
            try { if (__hoveredLayer === layer) __hoveredLayer = null; } catch (_) {}
        });
    } catch (_) {}
}

function __dedupAndEmitLayerEdit(layer) {
    try {
        if (!layer || !layer._drawSyncId || !__emitRef || !__emitRef.drawEdit) return;
        const feature = layerToSerializable(layer);
        const id = layer._drawSyncId;
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (!map) return;
        const store = map.__squadmapsLastEditSigById || (map.__squadmapsLastEditSigById = {});
        const sig = JSON.stringify(feature || {});
        if (store[id] === sig) return;
        store[id] = sig;
        try { __emitRef.drawEdit([{id, geojson: feature}]); } catch (_) {}
    } catch (_) {}
}

function __scheduleEmitLayerEdit(layer, delay = __editEmitDebounceMs) {
    try {
        if (!layer) return;
        if (layer.__squadEditEmitTimer) clearTimeout(layer.__squadEditEmitTimer);
        layer.__squadEditEmitTimer = setTimeout(() => {
            try { __dedupAndEmitLayerEdit(layer); } catch (_) {}
        }, Math.max(0, delay));
    } catch (_) {}
}

function __flushLayerEditEmit(layer) {
    try {
        if (!layer) return;
        if (layer.__squadEditEmitTimer) clearTimeout(layer.__squadEditEmitTimer);
        __dedupAndEmitLayerEdit(layer);
    } catch (_) {}
}

function __attachPerLayerEditEmit(layer) {
    try {
        if (!layer || layer.__squadEditEmitBound) return;
        layer.__squadEditEmitBound = true;
        const onEdited = () => __scheduleEmitLayerEdit(layer);
        const onMoved = () => __scheduleEmitLayerEdit(layer);
        layer.__squadOnEdited = onEdited;
        layer.__squadOnMoved = onMoved;
        if (layer.on) {
            // Vectors emit 'edit' when vertices/shape change
            layer.on('edit', onEdited);
            // Markers emit 'moveend' after dragging
            layer.on('moveend', onMoved);
        }
    } catch (_) {}
}

function __detachPerLayerEditEmit(layer) {
    try {
        if (!layer || !layer.__squadEditEmitBound) return;
        if (layer.off) {
            if (layer.__squadOnEdited) layer.off('edit', layer.__squadOnEdited);
            if (layer.__squadOnMoved) layer.off('moveend', layer.__squadOnMoved);
        }
        if (layer.__squadEditEmitTimer) clearTimeout(layer.__squadEditEmitTimer);
        delete layer.__squadEditEmitTimer;
        delete layer.__squadOnEdited;
        delete layer.__squadOnMoved;
        delete layer.__squadEditEmitBound;
    } catch (_) {}
}

function __isLayerEditing(layer) {
    try {
        if (!layer || !layer.editing) return false;
        if (typeof layer.editing.enabled === 'function') return !!layer.editing.enabled();
        if ('_enabled' in layer.editing) return !!layer.editing._enabled;
    } catch (_) {}
    return false;
}

function __stopEditingActiveLayer(suppressEmit = false) {
    try {
        const l = __activeEditedLayer;
        if (!l) return;
        // Emit final state unless explicitly suppressed (e.g., on delete)
        if (!suppressEmit) {
            try { __flushLayerEditEmit(l); } catch (_) {}
        }
        __detachPerLayerEditEmit(l);
        if (l.editing && typeof l.editing.disable === 'function') {
            try { l.editing.disable(); } catch (_) {}
        }
        if (l.dragging && typeof l.dragging.disable === 'function') {
            try { l.dragging.disable(); } catch (_) {}
        }
    } catch (_) {}
    __activeEditedLayer = null;
    try { restorePointerBlockers(); } catch (_) {}
}

function __startEditingLayer(layer) {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map || !layer) return;
    // Disable editing on any other layers to enforce single-active editing
    try {
        const group = map.__squadmapsDrawnItems;
        if (group && group.eachLayer) {
            group.eachLayer(l => {
                try {
                    if (l !== layer && l.editing && (typeof l.editing.disable === 'function') && __isLayerEditing(l)) {
                        l.editing.disable();
                    }
                    if (l !== layer && l.dragging && typeof l.dragging.disable === 'function') {
                        l.dragging.disable();
                    }
                    if (l !== layer) __detachPerLayerEditEmit(l);
                } catch (_) {}
            });
        }
    } catch (_) {}
    // Enable appropriate editing for the target
    if (layer.editing && typeof layer.editing.enable === 'function') {
        try { layer.editing.enable(); } catch (_) {}
    } else if (layer.dragging && typeof layer.dragging.enable === 'function') {
        try { layer.dragging.enable(); } catch (_) {}
    }
    __attachPerLayerEditEmit(layer);
    try { layer.bringToFront && layer.bringToFront(); } catch (_) {}
    __activeEditedLayer = layer;
    try { disablePointerBlockers(map); } catch (_) {}
}

function __editLayerAtEvent(e) {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    const layer = __layerFromEventOrCursor(e);
    if (map && layer) {
        console.log('[draw] __editLayerAtEvent: found layer', layer);
        // Toggle if the same layer is already active
        if (__activeEditedLayer && __activeEditedLayer === layer) {
            __stopEditingActiveLayer();
            console.log('[draw] Stopped editing current layer:', layer._drawSyncId);
            return;
        }
        // Stop any previous and start editing this one
        __stopEditingActiveLayer();
        __startEditingLayer(layer);
        if (__isLayerEditing(layer) || (layer.dragging && layer.dragging._enabled)) {
            console.log('[draw] Editing layer at event:', layer._drawSyncId);
        } else {
            console.log('[draw] Edit not available for layer at event');
        }
    } else {
        console.log('[draw] __editLayerAtEvent: missing map or event');
    }
}

function __deleteLayerAtEvent(e) {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    const group = map && map.__squadmapsDrawnItems;
    const layer = __layerFromEventOrCursor(e);
    if (map && group && layer) {
        console.log('[draw] __deleteLayerAtEvent: found layer', layer);
        // If deleting the active edited layer, stop editing first (without emitting)
        if (__activeEditedLayer && __activeEditedLayer === layer) {
            __stopEditingActiveLayer(true);
        }
        // Capture for undo before removal
        const id = layer._drawSyncId;
        const serialized = layerToSerializable(layer);
        try { group.removeLayer(layer); } catch (_) {}
        try {
            map.__squadmapsLayerIdMap = map.__squadmapsLayerIdMap || {};
            if (id) delete map.__squadmapsLayerIdMap[id];
        } catch (_) {}
        if (id && __emitRef && __emitRef.drawDelete) {
            try { __emitRef.drawDelete([id]); } catch (_) {}
        }
        if (serialized && id) {
            try {
                __undoStack.push({action: 'delete', layers: [{id, feature: serialized}]});
                __redoStack = [];
            } catch (_) {}
        }
        console.log('[draw] Deleted layer at event:', id || '(no id)');
    } else {
        console.log('[draw] __deleteLayerAtEvent: missing map or event');
    }
}

function __handleKeydown(e) {
    // Undo/redo
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        __undo();
    } else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        __redo();
    }
    // While toolbar edit mode is active, treat E/Enter as Save
    else if (__toolbarEditModeActive && (e.key === 'e' || e.key === 'E' || e.key === 'Enter')) {
        e.preventDefault();
        const ok = __clickToolbarSave();
        if (ok) {
            try { __toolbarEditModeActive = false; } catch (_) {}
            return;
        }
        // Fallback: flush and stop any active manual edit and restore pointers
        __stopEditingActiveLayer();
        try { __toolbarEditModeActive = false; } catch (_) {}
    }
    // Delete layer at mouse event
    else if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === "d" || e.key === "D")) {
        e.preventDefault();
        console.log('[draw] __handleKeydown: delete key pressed', e.key);
        __deleteLayerAtEvent(e);
    }
    // Edit layer at mouse event
    else if ((e.key === 'e' || e.key === 'E' || e.key === 'Enter')) {
        e.preventDefault();
        // If no hovered layer but a layer is currently being edited, treat as save/stop
        if (!__toolbarEditModeActive && !__hoveredLayer && __activeEditedLayer) {
            __stopEditingActiveLayer();
            return;
        }
        console.log('[draw] __handleKeydown: edit key pressed', e.key);
        __editLayerAtEvent(e);
    }
}

function __clickToolbarSave() {
    try {
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (!map) return false;
        let success = false;
        // 1) Try clicking the visible Save button
        try {
            const root = map._container || document;
            let btn = (root && root.querySelector && (root.querySelector('.leaflet-draw-actions .leaflet-draw-edit-save')
                || root.querySelector('.leaflet-draw-actions a.leaflet-draw-edit-save')
                || root.querySelector('[class*="leaflet-draw-edit-save"]')));
            if (!btn && typeof document !== 'undefined') {
                btn = document.querySelector('.leaflet-draw-actions .leaflet-draw-edit-save')
                    || document.querySelector('[class*="leaflet-draw-edit-save"]');
            }
            if (btn) {
                try {
                    btn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                    success = true;
                } catch (_) {
                    try { btn.click(); success = true; } catch (__) {}
                }
            }
        } catch (_) {}
        if (success) return true;
        // 2) Fallback to internal toolbar API
        try {
            const ctrl = map.__squadmapsDrawControl || null;
            const editTb = ctrl && ctrl._toolbars && (ctrl._toolbars.edit || null);
            if (editTb) {
                // Try toolbar-level _save(), then disable active handler
                let didSave = false;
                try { if (typeof editTb._save === 'function') { editTb._save(); didSave = true; } } catch (_) {}
                // Disable edit toolbar mode to exit
                try {
                    if (typeof editTb.disable === 'function') editTb.disable();
                    else if (editTb._activeMode && editTb._activeMode.handler && typeof editTb._activeMode.handler.disable === 'function') {
                        editTb._activeMode.handler.disable();
                    }
                } catch (_) {}
                if (didSave) return true;
            }
        } catch (_) {}
    } catch (_) {}
    return false;
}

function __addUndoListener() {
    if (!__undoListenerAdded && typeof window !== 'undefined') {
        window.addEventListener('keydown', __handleKeydown);
        __undoListenerAdded = true;
    }
}

function __undo() {
    try {
        const op = __undoStack.pop();
        if (!op) return;
        const map = window.squadMap;
        const group = map && map.__squadmapsDrawnItems;
        if (!group) return;
        if (op.action === 'create') {
            const layer = map.__squadmapsLayerIdMap && map.__squadmapsLayerIdMap[op.id];
            if (layer) {
                group.removeLayer(layer);
                delete map.__squadmapsLayerIdMap[op.id];
            }
            if (__emitRef && __emitRef.drawDelete) __emitRef.drawDelete([op.id]);
            __redoStack.push(op);
        } else if (op.action === 'delete') {
            const recreated = [];
            op.layers.forEach(item => {
                const layer = geojsonToLayer(item.feature);
                if (layer) {
                    layer._drawSyncId = item.id;
                    group.addLayer(layer);
                    map.__squadmapsLayerIdMap = map.__squadmapsLayerIdMap || {};
                    map.__squadmapsLayerIdMap[item.id] = layer;
                    recreated.push(item);
                }
            });
            recreated.forEach(item => {
                if (__emitRef && __emitRef.drawCreate) __emitRef.drawCreate({id: item.id, geojson: item.feature});
            });
            __redoStack.push(op);
        }
    } catch (_) {
    }
}

function __redo() {
    try {
        const op = __redoStack.pop();
        if (!op) return;
        const map = window.squadMap;
        const group = map && map.__squadmapsDrawnItems;
        if (!group) return;
        if (op.action === 'create') {
            const layer = geojsonToLayer(op.feature);
            if (layer) {
                layer._drawSyncId = op.id;
                group.addLayer(layer);
                map.__squadmapsLayerIdMap = map.__squadmapsLayerIdMap || {};
                map.__squadmapsLayerIdMap[op.id] = layer;
                if (__emitRef && __emitRef.drawCreate) __emitRef.drawCreate({id: op.id, geojson: op.feature});
            }
            __undoStack.push(op);
        } else if (op.action === 'delete') {
            const ids = [];
            op.layers.forEach(item => {
                const layer = map.__squadmapsLayerIdMap && map.__squadmapsLayerIdMap[item.id];
                if (layer) {
                    group.removeLayer(layer);
                    delete map.__squadmapsLayerIdMap[item.id];
                    ids.push(item.id);
                }
            });
            if (ids.length && __emitRef && __emitRef.drawDelete) __emitRef.drawDelete(ids);
            __undoStack.push(op);
        }
    } catch (_) {
    }
}

function ensureLeafletDrawAssets() {
    try {
        if (typeof document === 'undefined') return;
        // Ensure Leaflet.draw CSS
        if (!document.getElementById('leaflet-draw-css')) {
            const link = document.createElement('link');
            link.id = 'leaflet-draw-css';
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css';
            try {
                document.head.appendChild(link);
            } catch (_) {
            }
        }
        // If Draw already present or script already requested, stop here
        if (typeof window !== 'undefined' && window.L && L.Control && L.Control.Draw) return;
        if (__assetsRequested || document.getElementById('leaflet-draw-js')) return;
        const s = document.createElement('script');
        s.id = 'leaflet-draw-js';
        s.src = 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js';
        s.async = true;
        s.defer = true;
        s.onload = () => { /* no-op; initDraw polling will detect availability */
        };
        s.onerror = () => {
            try {
                __assetsRequested = false;
            } catch (_) {
            }
        };
        __assetsRequested = true;
        try {
            document.head.appendChild(s);
        } catch (_) {
            try {
                document.body.appendChild(s);
            } catch (__) {
            }
        }
    } catch (_) {
    }
}

function disablePointerBlockers(map) {
    try {
        if (!map || !map._container) return;
        __pointerBlockers = [];
        map._container.querySelectorAll('canvas, .leaflet-triggers-pane, .Ground_ground__container__Hoq0Z').forEach(el => {
            try {
                const pe = getComputedStyle(el).pointerEvents;
                if (pe !== 'none') {
                    __pointerBlockers.push({el, prev: el.style.pointerEvents});
                    el.style.pointerEvents = 'none';
                }
            } catch (_) {
            }
        });
    } catch (_) {
    }
}

function restorePointerBlockers() {
    try {
        (__pointerBlockers || []).forEach(rec => {
            try {
                rec.el.style.pointerEvents = rec.prev || '';
            } catch (_) {
            }
        });
    } catch (_) {
    }
    __pointerBlockers = [];
}

// Helper to inspect active draw handler safely (polyline/polygon/rect/circle)
function __collectActivePoints() {
    try {
        const h = (typeof window !== 'undefined' && window.__squadActiveDrawHandler) || null;
        if (!h) return {type: null, points: [], circle: null, rectangle: null};
        const isPolyline = (window.L && L.Draw && L.Draw.Polyline && h instanceof L.Draw.Polyline);
        const isPolygon = (window.L && L.Draw && L.Draw.Polygon && h instanceof L.Draw.Polygon);
        const isRect = (window.L && L.Draw && L.Draw.Rectangle && h instanceof L.Draw.Rectangle);
        const isCircle = (window.L && L.Draw && L.Draw.Circle && h instanceof L.Draw.Circle);

        if (isPolyline || isPolygon) {
            let latlngs = [];
            try {
                if (h._poly && typeof h._poly.getLatLngs === 'function') {
                    const v = h._poly.getLatLngs();
                    latlngs = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : [];
                } else if (Array.isArray(h._markers)) {
                    latlngs = h._markers.map(m => (m && m.getLatLng && m.getLatLng()) || null).filter(Boolean);
                }
            } catch (_) {
                latlngs = [];
            }
            const pts = latlngs.map(ll => ({lat: ll.lat, lng: ll.lng}));
            return {type: isPolygon ? 'polygon' : 'polyline', points: pts, circle: null, rectangle: null};
        }
        if (isRect) {
            try {
                const shape = h._shape; // L.Rectangle while dragging
                if (shape && typeof shape.getBounds === 'function') {
                    const b = shape.getBounds();
                    const sw = b.getSouthWest();
                    const ne = b.getNorthEast();
                    return {
                        type: 'rectangle',
                        points: [{lat: sw.lat, lng: sw.lng}, {lat: ne.lat, lng: ne.lng}],
                        circle: null,
                        rectangle: {sw: {lat: sw.lat, lng: sw.lng}, ne: {lat: ne.lat, lng: ne.lng}}
                    };
                }
            } catch (_) {
            }
            return {type: 'rectangle', points: [], circle: null, rectangle: null};
        }
        if (isCircle) {
            try {
                const shape = h._shape; // L.Circle while dragging
                if (shape && typeof shape.getLatLng === 'function' && typeof shape.getRadius === 'function') {
                    const c = shape.getLatLng();
                    const r = shape.getRadius();
                    return {
                        type: 'circle',
                        points: [],
                        circle: {center: {lat: c.lat, lng: c.lng}, radius: r},
                        rectangle: null
                    };
                }
            } catch (_) {
            }
            return {type: 'circle', points: [], circle: null, rectangle: null};
        }
        return {type: null, points: [], circle: null, rectangle: null};
    } catch (_) {
        return {type: null, points: [], circle: null, rectangle: null};
    }
}

function startProgress(emit, type) {
    try {
        stopProgress();
    } catch (_) {
    }
    __progressType = type || null;
    __progressId = generateId();
    __progressLastSig = '';
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map || !emit || !emit.drawProgress) return;
    __progressTimer = setInterval(() => {
        try {
            const snap = __collectActivePoints();
            if (!snap || !snap.type || (snap.type !== __progressType && !(snap.type === 'polygon' && __progressType === 'polyline'))) return;
            const payload = {id: __progressId, shapeType: snap.type};
            if (snap.type === 'circle' && snap.circle) {
                payload.center = snap.circle.center;
                payload.radius = snap.circle.radius;
                payload.points = [];
            } else if (snap.type === 'rectangle' && (snap.rectangle || (snap.points && snap.points.length === 2))) {
                payload.points = (snap.rectangle ? [snap.rectangle.sw, snap.rectangle.ne] : snap.points);
            } else {
                payload.points = snap.points || [];
            }
            const sig = JSON.stringify(payload);
            if (sig !== __progressLastSig) {
                __progressLastSig = sig;
                try {
                    emit.drawProgress(payload);
                } catch (_) {
                }
            }
        } catch (_) {
        }
    }, 120);
}

function stopProgress() {
    try {
        if (__progressTimer) clearInterval(__progressTimer);
    } catch (_) {
    }
    __progressTimer = null;
    if (__progressId && __emitRef && __emitRef.drawProgress) {
        try {
            __emitRef.drawProgress({id: __progressId, shapeType: __progressType || 'polyline', points: [], end: true});
        } catch (_) {
        }
    }
    __progressId = null;
    __progressType = null;
    __progressLastSig = '';
}

// Helper: push draw toolbar down to avoid overlapping site UI (e.g., settings icon)
function ensureToolbarOffsetCss(px = 100) {
    try {
        const id = 'draw-toolbar-offset-css';
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = `.leaflet-top.leaflet-left .leaflet-draw-toolbar.leaflet-bar { margin-top: ${px}px !important; }`;
        document.head.appendChild(style);
    } catch (_) {
    }
}

// Add CSS adjustments so the draw control container doesn't block clicks and toolbar has no border
function ensureToolbarFixCss() {
    try {
        const id = 'draw-toolbar-fixes-css';
        if (document.getElementById(id)) return;
        const st = document.createElement('style');
        st.id = id;
        st.textContent = `
/* Prevent the outer draw control container from absorbing clicks */
.leaflet-draw.leaflet-control { pointer-events: none !important; background: transparent !important; }
.leaflet-draw.leaflet-control .leaflet-bar,
.leaflet-draw.leaflet-control .leaflet-draw-toolbar,
.leaflet-draw.leaflet-control .leaflet-draw-actions { pointer-events: auto !important; }
/* Remove border/background from the draw toolbar wrapper */
.leaflet-draw-toolbar.leaflet-bar { border: 0 !important; box-shadow: none !important; background: transparent !important; }
`;
        document.head.appendChild(st);
    } catch (_) {
    }
}

// Ensure vector layers (especially circles) remain interactive with Canvas renderer
function ensureCircleInteractiveCss() {
    try {
        const id = 'squadmaps-circle-interactive-css';
        if (document.getElementById(id)) return;
        const st = document.createElement('style');
        st.id = id;
        // Keep pointer events enabled on interactive vector layers (Leaflet adds .leaflet-interactive)
        st.textContent = `.leaflet-canvas path.leaflet-interactive, .leaflet-overlay-pane svg path.leaflet-interactive { pointer-events: auto !important; }`;
        document.head.appendChild(st);
    } catch (_) {
    }
}

function ensureFAMarkerCss() {
    if (document.getElementById('squadmaps-fa')) return; // toolbar-extras/markers may already add FA
    const link = document.createElement('link');
    link.id = 'squadmaps-fa';
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
    document.head.appendChild(link);
    if (!document.getElementById('squadmaps-fa-marker-css')) {
        const st = document.createElement('style');
        st.id = 'squadmaps-fa-marker-css';
        st.textContent = `.squad-fa-marker-wrap{background:transparent!important;border:0!important;}
.squad-fa-marker-wrap .squad-fa-marker{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.squad-fa-marker-wrap i{pointer-events:none;}`;
        document.head.appendChild(st);
    }
}

function faDivIcon(iconName, colorHex) {
    try {
        ensureFAMarkerCss();
    } catch (_) {
    }
    const icon = iconName || 'location-dot';
    const color = (colorHex && /^#?[0-9a-fA-F]{6}$/.test(colorHex)) ? (colorHex[0] === '#' ? colorHex : ('#' + colorHex)) : ((typeof window !== 'undefined' && window.userColor) || '#ff6600');
    const size = 48, fontSize = 35;
    const centerAnchored = icon === 'crosshairs' || icon === 'circle';
    const anchor = centerAnchored ? [size / 2, size / 2] : [Math.round(size / 2), size - 5];
    const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${icon}" style="color:${color};font-size:${fontSize}px;line-height:1"></i></div>`;
    return L.divIcon({
        className: 'leaflet-div-icon squad-fa-marker-wrap',
        html,
        iconSize: [size, size],
        iconAnchor: anchor
    });
}

function __hostWindow() {
    try {
        return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    } catch (_) {
        return window;
    }
}

function __fallbackFindExistingMap() {
    try {
        const W = __hostWindow();
        // Prefer exact instance check when L is available
        if (W && W.L && W.L.Map) {
            if (W.squadMap && W.squadMap instanceof W.L.Map) return W.squadMap;
            const keys = Object.keys(W);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                try {
                    const v = W[k];
                    if (v && v instanceof W.L.Map) {
                        try {
                            W.squadMap = v;
                        } catch (_) {
                        }
                        try {
                            window.squadMap = v;
                        } catch (_) {
                        }
                        if (!__loggedMapScanOnce) {
                            try {
                                console.log('[draw] captured existing map via window scan at', k);
                            } catch (_) {
                            }
                            __loggedMapScanOnce = true;
                        }
                        return v;
                    }
                } catch (_) {
                }
            }
        }
        // Heuristic: L may not be global; detect by shape
        if (W) {
            const keys = Object.keys(W);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                let v;
                try {
                    v = W[k];
                } catch (_) {
                    continue;
                }
                try {
                    if (!v || typeof v !== 'object') continue;
                    const hasMethods = typeof v.on === 'function' && typeof v.addLayer === 'function' && typeof v.removeLayer === 'function';
                    const hasView = typeof v.setView === 'function' || typeof v.panTo === 'function' || typeof v.fitBounds === 'function';
                    const cont = v._container;
                    const looksLikeContainer = cont && cont.nodeType === 1 && cont.classList && cont.classList.contains('leaflet-container');
                    if (hasMethods && hasView && looksLikeContainer) {
                        try {
                            W.squadMap = v;
                        } catch (_) {
                        }
                        try {
                            window.squadMap = v;
                        } catch (_) {
                        }
                        if (!__loggedMapScanOnce) {
                            try {
                                console.log('[draw] captured existing map via heuristic scan at', k);
                            } catch (_) {
                            }
                            __loggedMapScanOnce = true;
                        }
                        return v;
                    }
                } catch (_) {
                }
            }
        }
    } catch (_) {
    }
    return null;
}

function waitForMap() {
    try {
        const W = __hostWindow();
        if (!W || !W.L || !W.L.Map) return false;
        if (W.squadMap instanceof W.L.Map) return true;
        const found = __fallbackFindExistingMap();
        return !!(found && found instanceof W.L.Map);
    } catch (_) {
        return false;
    }
}

function ensureFeatureGroup(map) {
    if (!map) return null;
    const existing = map.__squadmapsDrawnItems;
    if (existing) {
        try {
            if (!map.hasLayer || !map.hasLayer(existing)) {
                existing.addTo(map);
            }
            return existing;
        } catch (_) { /* fall-through to recreate */
        }
    }
    const group = new L.FeatureGroup();
    try {
        group.addTo(map);
    } catch (_) {
    }
    map.__squadmapsDrawnItems = group;
    return group;
}

function ensureProgressGroup(map) {
    if (!map) return null;
    if (map.__squadmapsProgressGroup && map.hasLayer && map.hasLayer(map.__squadmapsProgressGroup)) return map.__squadmapsProgressGroup;
    const group = new L.FeatureGroup();
    try {
        group.addTo(map);
    } catch (_) {
    }
    map.__squadmapsProgressGroup = group;
    if (!map.__squadmapsProgressMap) map.__squadmapsProgressMap = {}; // id -> layer
    return group;
}

function colorFromHex(hex, fallback) {
    try {
        if (typeof hex === 'string') {
            const v = hex[0] === '#' ? hex : ('#' + hex);
            if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
        }
    } catch (_) {
    }
    return fallback || '#ff6600';
}

function generateId() {
    // short random id; unique enough for session-level syncing
    return 'd' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

// Helper: does the map container currently have any Leaflet.Draw toolbar DOM?
function hasToolbarDom(map) {
    try {
        const el = map && map._container;
        if (!el) return false;
        return !!el.querySelector('.leaflet-draw-toolbar.leaflet-bar');
    } catch (_) {
        return false;
    }
}

// Ensure a draw toolbar is attached to the given map and configured with current color
function ensureToolbarPresent(map) {
    try {
        // Skip ensuring toolbar on non-map selector routes to avoid spam
        if (!__isActiveMapPath()) {
            try {
                const prev = map && map.__squadmapsDrawControl;
                if (prev && map) {
                    try {
                        map.removeControl(prev);
                    } catch (_) {
                    }
                    try {
                        map.__squadmapsDrawControl = null;
                    } catch (_) {
                    }
                }
            } catch (_) {
            }
            return;
        }
        if (!map || !window.L || !L.Control || !L.Control.Draw) {
            try {
                console.log('[draw] ensureToolbarPresent: Draw not ready');
            } catch (_) {
            }
            return;
        }
        const group = ensureFeatureGroup(map);

        const curCtrl = map.__squadmapsDrawControl || null;
        const toolbarInDom = hasToolbarDom(map);

        if (!curCtrl || !toolbarInDom) {
            try {
                console.log('[draw] (re)adding draw control; hadCtrl=', !!curCtrl, 'toolbarInDom=', toolbarInDom);
            } catch (_) {
            }
            try {
                if (curCtrl) {
                    try {
                        map.removeControl(curCtrl);
                    } catch (_) {
                    }
                    map.__squadmapsDrawControl = null;
                }
            } catch (_) {
            }
            const baseColor = (typeof window !== 'undefined' && window.userColor) || '#ff6600';
            const ctrl = setupToolbar(map, group, baseColor);
            try {
                console.log('[draw] draw control ready', !!ctrl);
            } catch (_) {
            }
            return;
        }

        // Update live options
        try {
            const c = ((typeof window !== 'undefined' && window.userColor) || '#ff6600').toLowerCase();
            const d = curCtrl.options && curCtrl.options.draw ? curCtrl.options.draw : null;
            if (d) {
                ['polyline', 'polygon', 'rectangle', 'circle'].forEach(k => {
                    try {
                        if (d[k] && d[k].shapeOptions) {
                            d[k].shapeOptions.color = c;
                            if (d[k].shapeOptions.fillColor !== undefined) d[k].shapeOptions.fillColor = c;
                            d[k].shapeOptions.opacity = 1;
                        }
                    } catch (_) {
                    }
                });
                // Ensure marker icon reflects color and current icon name if provided by markers module
                try {
                    const iconName = (d.marker && d.marker.iconName) || (window.__squadMarkerIconName) || 'crosshairs';
                    d.marker = d.marker || {};
                    d.marker.icon = faDivIcon(iconName, c);
                    d.marker.iconName = iconName;
                } catch (_) {
                }
            }
            // Ensure offset CSS exists
            try {
                ensureToolbarOffsetCss(100);
            } catch (_) {
            }
            // Ensure toolbar UI fixes are present
            try {
                ensureToolbarFixCss();
            } catch (_) {
            }
        } catch (_) {
        }
    } catch (_) {
    }
}

// Observe DOM changes in the map container and re-ensure toolbar if it disappears
function observeToolbar(map) {
    try {
        if (!map || !map._container || (typeof MutationObserver === 'undefined')) return;
        if (__toolbarObserver) {
            try {
                __toolbarObserver.disconnect();
            } catch (_) {
            }
            __toolbarObserver = null;
        }
        __toolbarObserver = new MutationObserver(() => {
            try {
                if (__toolbarEnsureDebounce) clearTimeout(__toolbarEnsureDebounce);
            } catch (_) {
            }
            __toolbarEnsureDebounce = setTimeout(() => {
                try {
                    ensureToolbarPresent(map);
                } catch (_) {
                }
            }, 80);
        });
        try {
            __toolbarObserver.observe(map._container, {childList: true, subtree: true});
        } catch (_) {
        }
    } catch (_) {
    }
}

// One-time: hook Leaflet map creation to ensure toolbar on new instances (SPA / remote changes)
(function hookLeafletInit() {
    try {
        if (__hookedInitOnce) return;
        let tries = 0;
        const tryInstall = () => {
            try {
                if (__hookedInitOnce) return; // already installed
                const W = __hostWindow();
                if (!W || !W.L || !W.L.Map) {
                    if (tries++ < 200) return; // ~40s max at 200ms
                    return;
                }
                if (W.L.Map && typeof W.L.Map.addInitHook === 'function') {
                    W.L.Map.addInitHook(function () {
                        try {
                            try {
                                W.squadMap = this;
                            } catch (_) {
                            }
                            try {
                                window.squadMap = this;
                            } catch (_) {
                            }
                            try {
                                console.log('[draw] map init fired');
                            } catch (_) {
                            }
                            ensureFeatureGroup(this);
                            ensureProgressGroup(this);
                            try {
                                ensureLeafletDrawAssets();
                            } catch (_) {
                            }
                            try {
                                if (typeof recheckDrawToolbar === 'function') recheckDrawToolbar(); else ensureToolbarPresent(this);
                            } catch (_) {
                                try {
                                    ensureToolbarPresent(this);
                                } catch (__) {
                                }
                            }
                            observeToolbar(this);
                        } catch (_) {
                        }
                    });
                    // Also capture map on any event fired by a Map instance (covers SPA swaps without new init)
                    try {
                        if (W.L.Evented && !W.L.Evented.__squadEventedCapturePatched) {
                            const origFire = W.L.Evented.prototype.fire;
                            if (typeof origFire === 'function') {
                                W.L.Evented.prototype.fire = function (type, data, propagate) {
                                    try {
                                        if (this && W.L && W.L.Map && this instanceof W.L.Map) {
                                            try {
                                                W.squadMap = this;
                                            } catch (_) {
                                            }
                                            try {
                                                window.squadMap = this;
                                            } catch (_) {
                                            }
                                        }
                                    } catch (_) {
                                    }
                                    return origFire.call(this, type, data, propagate);
                                };
                                W.L.Evented.__squadEventedCapturePatched = true;
                                try {
                                    console.log('[draw] patched Evented.fire for map capture');
                                } catch (_) {
                                }
                            }
                        }
                    } catch (_) {
                    }
                    __hookedInitOnce = true;
                    try {
                        console.log('[draw] installed map init hook');
                    } catch (_) {
                    }
                }
            } catch (_) {
            }
        };
        tryInstall();
        const t = setInterval(() => {
            if (__hookedInitOnce) {
                clearInterval(t);
                return;
            }
            tryInstall();
            if (__hookedInitOnce) clearInterval(t);
        }, 200);
    } catch (_) {
    }
})();

// ---- Serialization helpers ----
export function layerToSerializable(layer) {
    if (!layer) return null;
    try {
        // Detect shape type
        let shapeType = 'unknown';
        if (layer instanceof L.Rectangle) shapeType = 'rectangle';
        else if (layer instanceof L.Polygon && !(layer instanceof L.Rectangle)) shapeType = 'polygon';
        else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) shapeType = 'polyline';
        else if (layer instanceof L.Circle) shapeType = 'circle';
        else if (layer instanceof L.Marker) shapeType = 'marker';

        const opts = Object.assign({}, layer.options || {});
        const style = {
            color: opts.color || '#ff6600',
            weight: typeof opts.weight === 'number' ? opts.weight : 2,
            opacity: typeof opts.opacity === 'number' ? opts.opacity : 1,
            fill: !!opts.fill,
            fillColor: opts.fillColor || opts.color || '#ff6600',
            fillOpacity: typeof opts.fillOpacity === 'number' ? opts.fillOpacity : 0.2
        };

        let geometry = null;
        if (shapeType === 'rectangle') {
            const b = layer.getBounds();
            const sw = b.getSouthWest();
            const ne = b.getNorthEast();
            const nw = L.latLng(ne.lat, sw.lng);
            const se = L.latLng(sw.lat, ne.lng);
            geometry = {
                type: 'Polygon',
                coordinates: [[
                    [nw.lng, nw.lat],
                    [ne.lng, ne.lat],
                    [se.lng, se.lat],
                    [sw.lng, sw.lat],
                    [nw.lng, nw.lat]
                ]]
            };
        } else if (shapeType === 'polygon') {
            const rings = layer.getLatLngs();
            const ring = Array.isArray(rings) ? (Array.isArray(rings[0]) ? rings[0] : rings) : [];
            geometry = {
                type: 'Polygon',
                coordinates: [ring.map(ll => [ll.lng, ll.lat])]
            };
            // ensure closed
            const coords = geometry.coordinates[0];
            if (coords.length && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
                coords.push([coords[0][0], coords[0][1]]);
            }
        } else if (shapeType === 'polyline') {
            const pts = layer.getLatLngs();
            geometry = {
                type: 'LineString',
                coordinates: pts.map(ll => [ll.lng, ll.lat])
            };
        } else if (shapeType === 'circle') {
            const c = layer.getLatLng();
            geometry = {type: 'Point', coordinates: [c.lng, c.lat]};
        } else if (shapeType === 'marker') {
            const c = layer.getLatLng();
            geometry = {type: 'Point', coordinates: [c.lng, c.lat]};
        }

        const props = {
            shapeType,
            style,
            color: style.color, // duplicate base colors for compatibility
            fillColor: style.fillColor,
        };

        if (shapeType === 'circle') props.radius = Number(layer.getRadius());
        if (shapeType === 'marker') {
            // optional extra metadata for custom icons
            if (layer.__faIconName) props.icon = layer.__faIconName;
            if (layer.__faColor) props.iconColor = layer.__faColor;
        }

        return {type: 'Feature', geometry, properties: props};
    } catch (e) {
        console.warn('[draw] serialize failed', e);
        return null;
    }
}

export function geojsonToLayer(feature) {
    if (!feature || !feature.geometry || !feature.properties) return null;
    try {
        const {geometry, properties} = feature;
        const t = properties.shapeType || (geometry.type === 'LineString' ? 'polyline' : geometry.type === 'Polygon' ? 'polygon' : 'marker');
        const st = properties.style || {};
        const base = st.color || properties.color || '#ff6600';
        const fillBase = st.fillColor || properties.fillColor || base;
        const style = {
            color: colorFromHex(base, '#ff6600'),
            weight: typeof st.weight === 'number' ? st.weight : 2,
            opacity: typeof st.opacity === 'number' ? st.opacity : 1,
            fillColor: colorFromHex(fillBase, base),
            fillOpacity: typeof st.fillOpacity === 'number' ? st.fillOpacity : 0.2
        };

        if (t === 'rectangle' || (t === 'polygon' && geometry.type === 'Polygon')) {
            const coords = (geometry.coordinates && geometry.coordinates[0]) || [];
            const latlngs = coords.map(([lng, lat]) => L.latLng(lat, lng));
            if (t === 'rectangle' && latlngs.length >= 2) {
                // infer bounds from first/third points if present
                const lats = latlngs.map(p => p.lat);
                const lngs = latlngs.map(p => p.lng);
                const sw = L.latLng(Math.min(...lats), Math.min(...lngs));
                const ne = L.latLng(Math.max(...lats), Math.max(...lngs));
                return L.rectangle(L.latLngBounds(sw, ne), style);
            }
            return L.polygon(latlngs, Object.assign({fill: true}, style));
        }
        if (t === 'polyline' && geometry.type === 'LineString') {
            const coords = geometry.coordinates || [];
            const latlngs = coords.map(([lng, lat]) => L.latLng(lat, lng));
            return L.polyline(latlngs, style);
        }
        if (t === 'circle' && geometry.type === 'Point') {
            const [lng, lat] = geometry.coordinates || [0, 0];
            const r = Number(properties.radius) || 1;
            return L.circle(L.latLng(lat, lng), Object.assign({}, style, {radius: r, fill: true}));
        }
        if (t === 'marker' && geometry.type === 'Point') {
            const [lng, lat] = geometry.coordinates || [0, 0];
            const m = L.marker(L.latLng(lat, lng));
            // Apply FA icon immediately for remote markers
            const iconName = properties.icon || m.__faIconName || 'location-dot';
            const iconColor = colorFromHex(properties.iconColor || style.color || '#ff6600');
            try {
                m.setIcon(faDivIcon(iconName, iconColor));
            } catch (_) {
            }
            m.__faIconName = iconName;
            m.__faColor = iconColor;
            return m;
        }
    } catch (e) {
        console.warn('[draw] deserialize failed', e);
    }
    return null;
}

function ensureLayerEditable(layer, editEnabled) {
    try {
        if (!layer) return;
        if (!layer.editing || typeof layer.editing.enable !== 'function') return;
        if (editEnabled) layer.editing.enable(); else if (typeof layer.editing.disable === 'function') layer.editing.disable();
    } catch (_) {
    }
}

function setupToolbar(map, group, baseColor) {
    if (!map || !L || !L.Control || !L.Control.Draw) return null;
    const color = colorFromHex(baseColor, '#ff6600');
    // Remove any existing control first to avoid duplicates/stale refs
    try {
        const prev = map.__squadmapsDrawControl;
        if (prev && prev._map === map) {
            try {
                map.removeControl(prev);
            } catch (_) {
            }
        }
    } catch (_) {
    }
    const ctrl = new L.Control.Draw({
        edit: {
            featureGroup: group,
            edit: true,
            remove: true
        },
        draw: {
            polyline: {shapeOptions: {color, weight: 3, opacity: 1}},
            polygon: {shapeOptions: {color, weight: 2, opacity: 1, fillColor: color, fillOpacity: 0.3}},
            rectangle: {shapeOptions: {color, weight: 2, opacity: 1, fillColor: color, fillOpacity: 0.2}},
            circle: {shapeOptions: {color, weight: 2, opacity: 1, fillColor: color, fillOpacity: 0.2}},
            marker: {icon: faDivIcon('crosshairs', color)},
            circlemarker: false
        }
    });
    try {
        map.addControl(ctrl);
    } catch (_) {
    }
    try {
        map.__squadmapsDrawControl = ctrl;
    } catch (_) {
    }
    // Remember default icon name for marker tool so live updates maintain crosshairs when no user choice
    try {
        if (ctrl && ctrl.options && ctrl.options.draw) ctrl.options.draw.marker.iconName = 'crosshairs';
    } catch (_) {
    }
    // Prevent toolbar from overlapping site UI
    try {
        ensureToolbarOffsetCss(100);
    } catch (_) {
    }
    // Also ensure toolbar CSS fixes are present
    try {
        ensureToolbarFixCss();
    } catch (_) {
    }
    // Ensure circles remain interactive when Canvas renderer is used
    try {
        ensureCircleInteractiveCss();
    } catch (_) {
    }
    // Notify other modules that toolbar is ready (for extras, etc.)
    try {
        window.dispatchEvent(new CustomEvent('squadmaps:drawToolbarReady', {detail: {map, control: ctrl}}));
    } catch (_) {
    }
    return ctrl;
}

// Use safer lookup for the internal draw toolbar across plugin versions
function getDrawToolbarFromControl(ctrl) {
    try {
        if (!ctrl) return null;
        if (ctrl._toolbars && (ctrl._toolbars.draw || ctrl._toolbars.edit)) {
            return ctrl._toolbars.draw || ctrl._toolbars.edit || null;
        }
        return ctrl._toolbar || null;
    } catch (_) {
        return null;
    }
}

function rearmLastTool(map) {
    try {
        if (!window.__squadContinuousMode) return;
        const type = __lastDrawType;
        if (!type) return;
        const ctrl = map && map.__squadmapsDrawControl;
        if (!ctrl) return;
        if (type === 'marker' && typeof window !== 'undefined' && window.__squadMarkerRadialOpen) {
            if (typeof window.__squadOnMarkerRadialClosedOnce === 'function') {
                window.__squadOnMarkerRadialClosedOnce(() => {
                    try {
                        rearmLastTool(map);
                    } catch (_) {
                    }
                });
                return;
            }
            setTimeout(() => rearmLastTool(map), 200);
            return;
        }
        let attempts = 0;
        const tryEnable = () => {
            attempts++;
            const drawTb = getDrawToolbarFromControl(ctrl);
            const modes = drawTb && drawTb._modes;
            if (!modes) {
                if (attempts < 12) return void setTimeout(tryEnable, 100);
                return;
            }
            const found = Object.values(modes).find(m => m && m.handler && m.handler.type === type);
            const handler = found && found.handler;
            if (handler && typeof handler.enable === 'function') {
                try {
                    handler.enable();
                } catch (_) {
                }
                return;
            }
            const button = found && found.button;
            if (button && typeof button.dispatchEvent === 'function') {
                try {
                    button.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                } catch (_) {
                }
            }
            if (attempts < 12) setTimeout(tryEnable, 120);
        };
        setTimeout(tryEnable, 60);
    } catch (_) {
    }
}

function onLayerRemoveClick(e) {
    if (!__removeModeActive) return;
    const layer = this;
    try {
        if (e && e.originalEvent) {
            e.originalEvent.stopPropagation();
            e.originalEvent.preventDefault();
        }
    } catch (_) {
    }
    const group = (layer && layer._eventParents) ? Object.values(layer._eventParents)[0] : null;
    try {
        group && group.removeLayer && group.removeLayer(layer);
    } catch (_) {
    }
    const id = layer && layer._drawSyncId;
    if (id && __emitRef && __emitRef.drawDelete) {
        try {
            __emitRef.drawDelete([id]);
        } catch (_) {
        }
    }
}

function attachRemoveHandler(layer) {
    try {
        if (!layer || layer.__removeModeHandlerAttached) return;
        layer.__removeModeHandlerAttached = true;
        layer.on && layer.on('click', onLayerRemoveClick);
    } catch (_) {
    }
}

function detachRemoveHandler(layer) {
    try {
        if (!layer || !layer.__removeModeHandlerAttached) return;
        layer.off && layer.off('click', onLayerRemoveClick);
        delete layer.__removeModeHandlerAttached;
    } catch (_) {
    }
}

function applyRemoveModeStyling(group, on) {
    try {
        if (!group) return;
        group.eachLayer && group.eachLayer(l => {
            try {
                if (l.setStyle) {
                    if (on) {
                        if (!l.__prevStyleForDelete) l.__prevStyleForDelete = Object.assign({}, l.options || {});
                        l.setStyle({dashArray: '6,6', opacity: 0.85});
                    } else if (l.__prevStyleForDelete) {
                        l.setStyle({
                            dashArray: l.__prevStyleForDelete.dashArray || null,
                            opacity: l.__prevStyleForDelete.opacity || 1
                        });
                    }
                }
                if (on) attachRemoveHandler(l); else detachRemoveHandler(l);
            } catch (_) {
            }
        });
    } catch (_) {
    }
}

export function initDraw(deps = {}) {
    // Dependencies: optional emitters to decouple sockets
    const emit = Object.assign({
        drawCreate: (_payload) => {
        },
        drawEdit: (_changes) => {
        },
        drawDelete: (_ids) => {
        },
        drawProgress: (_p) => {
        },
    }, deps.emit || {});
    __emitRef = emit; // save for remove click fallback

    // Avoid double-init if legacy script already active
    if (typeof window !== 'undefined') {
        if (window.__squadmapsLegacyDrawActive) return; // legacy guard if page sets it
    }

    let tries = 0;
    const start = () => {
        if (!waitForMap()) return false;
        const map = window.squadMap;
        if (!map) return false;
        // Allow re-init when map instance changes
        if (__mapRef && __mapRef !== map) {
            __drawInitOnce = false;
            try {
                if (__toolbarObserver && typeof __toolbarObserver.disconnect === 'function') {
                    __toolbarObserver.disconnect();
                }
            } catch (_) {
            }
            __toolbarObserver = null;
        }
        __mapRef = map;

        // Ensure Leaflet.Draw is present or request assets
        if (!(L && L.Control && L.Control.Draw)) {
            try {
                console.log('[draw] waiting for Leaflet.Draw assets');
            } catch (_) {
            }
            ensureLeafletDrawAssets();
            return false;
        }

        // Always ensure feature/progress groups exist on the current map
        const group = ensureFeatureGroup(map);
        ensureProgressGroup(map);

        // Ensure toolbar exists; if not, (re)attach it
        ensureToolbarPresent(map);

        if (__drawInitOnce) {
            // Already wired events for this map; make sure watchers are running
            if (!__toolbarWatchTimer) {
                __toolbarWatchTimer = setInterval(() => {
                    try {
                        ensureToolbarPresent(window && window.squadMap);
                    } catch (_) {
                    }
                }, 1000);
            }
            observeToolbar(map);
            return true;
        }

        // Inject larger edit vertex styling
        if (!document.getElementById('squadmaps-edit-vertex-css')) {
            const st = document.createElement('style');
            st.id = 'squadmaps-edit-vertex-css';
            st.textContent = `.leaflet-div-icon.leaflet-editing-icon { width: 16px !important; height: 16px !important; margin-left: -8px !important; margin-top: -8px !important; border: 2px solid #fff !important; box-shadow: 0 0 0 1px #000 !important; background:#f59e0b !important; }
.leaflet-edit-move .leaflet-div-icon.leaflet-editing-icon { background: #f59e0b !important; }
.leaflet-edit-resize .leaflet-div-icon.leaflet-editing-icon { background: #f59e0b !important; }`;
            document.head.appendChild(st);
        }

        // Remember last draw type for continuous re-arming
        map.on('draw:drawstart', (e) => {
            try {
                __lastDrawType = e && e.layerType || null;
                if (__lastDrawType === 'polyline' || __lastDrawType === 'polygon' || __lastDrawType === 'rectangle' || __lastDrawType === 'circle') startProgress(emit, __lastDrawType);
                disablePointerBlockers(map);
            } catch (_) {
            }
        });
        map.on('draw:drawstop', () => {
            stopProgress();
            restorePointerBlockers();
        });

        // Also manage pointer blockers for edit mode
        map.on('draw:editstart', () => {
            try {
                __activeEditedLayer = null; // reset manual tracking when toolbar edit mode begins
                __toolbarEditModeActive = true;
                // Attach live-edit emitters to all layers while toolbar edit is active
                const grp = map.__squadmapsDrawnItems;
                grp && grp.eachLayer && grp.eachLayer(l => { try { __attachPerLayerEditEmit(l); } catch (_) {} });
                // While editing, attach to any new layers added to the group
                if (grp && !grp.__squadToolbarEditLayerAddBound) {
                    grp.on && grp.on('layeradd', (ev) => { try { if (__toolbarEditModeActive) __attachPerLayerEditEmit(ev && ev.layer); } catch (_) {} });
                    grp.__squadToolbarEditLayerAddBound = true;
                }
                disablePointerBlockers(map);
            } catch (_) {
            }
        });
        map.on('draw:editstop', () => {
            try {
                // Flush and detach listeners from all layers
                const grp = map.__squadmapsDrawnItems;
                grp && grp.eachLayer && grp.eachLayer(l => {
                    try { __flushLayerEditEmit(l); } catch (_) {}
                    try { __detachPerLayerEditEmit(l); } catch (_) {}
                });
                __toolbarEditModeActive = false;
                __stopEditingActiveLayer();
            } catch (_) {
            }
        });

        // Core events
        map.on('draw:created', (e) => {
            try {
                const layer = e.layer;
                group.addLayer(layer);
                __addLayerHoverListener(layer);
                ensureLayerEditable(layer, false);
                // If a marker was placed, open the radial icon selector
                try {
                    if (layer instanceof L.Marker && typeof window.__squadOpenMarkerRadial === 'function') window.__squadOpenMarkerRadial(layer);
                } catch (_) {
                }
                const feature = layerToSerializable(layer);
                // Duplicate-create suppression (per-map signature)
                const sig = JSON.stringify(feature || {});
                const lastSig = map.__squadmapsLastCreateSig || '';
                const id = generateId();
                layer._drawSyncId = id;
                // Maintain id->layer map locally so remote deletes can remove our own shapes too
                try {
                    const idMap = map.__squadmapsLayerIdMap || (map.__squadmapsLayerIdMap = {});
                    idMap[id] = layer;
                } catch (_) {
                }
                if (sig !== lastSig) {
                    emit.drawCreate && emit.drawCreate({id, geojson: feature});
                    map.__squadmapsLastCreateSig = sig;
                    // push undo op
                    __undoStack.push({action: 'create', id, feature});
                    __redoStack = [];
                }
            } catch (err) {
                console.warn('[draw] draw:created handler failed', err);
            } finally {
                stopProgress();
                try {
                    rearmLastTool(map);
                } catch (_) {
                }
            }
        });

        // When marker icon changes via radial, emit a draw edit for that marker
        map.on('squad:markerIconChanged', (ev) => {
            try {
                const layer = ev && ev.layer;
                if (!layer || !layer._drawSyncId) return;
                const feature = layerToSerializable(layer);
                emit && emit.drawEdit && emit.drawEdit([{id: layer._drawSyncId, geojson: feature}]);
            } catch (_) {
            }
        });

        map.on('draw:edited', (e) => {
            try {
                const layers = e.layers;
                layers && layers.eachLayer && layers.eachLayer((layer) => {
                    // Use deduped single-layer emit to avoid duplicate final updates
                    __dedupAndEmitLayerEdit(layer);
                });
            } catch (err) {
                console.warn('[draw] draw:edited handler failed', err);
            }
        });

        map.on('draw:deleted', (e) => {
            try {
                const layers = e.layers;
                const ids = [];
                layers && layers.eachLayer && layers.eachLayer((layer) => {
                    if (layer._drawSyncId) ids.push(layer._drawSyncId);
                });
                if (ids.length) {
                    // capture deleted layers for undo
                    const removed = [];
                    layers.eachLayer(layer => {
                        if (layer._drawSyncId) {
                            removed.push({id: layer._drawSyncId, feature: layerToSerializable(layer)});
                        }
                    });
                    __undoStack.push({action: 'delete', layers: removed});
                    __redoStack = [];
                    // Remove from local id map as well
                    try {
                        const idMap = map.__squadmapsLayerIdMap || (map.__squadmapsLayerIdMap = {});
                        ids.forEach((id) => {
                            try {
                                delete idMap[id];
                            } catch (_) {
                            }
                        });
                    } catch (_) {
                    }
                    emit.drawDelete && emit.drawDelete(ids);
                }
            } catch (err) {
                console.warn('[draw] draw:deleted handler failed', err);
            }
        });

        // Remove mode enhancements: style + click-to-remove fallback
        map.on('draw:deletestart', () => {
            __removeModeActive = true;
            applyRemoveModeStyling(group, true);
            try {
                disablePointerBlockers(map);
            } catch (_) {
            }
        });
        map.on('draw:deletestop', () => {
            __removeModeActive = false;
            applyRemoveModeStyling(group, false);
            try {
                restorePointerBlockers();
            } catch (_) {
            }
        });

        __drawInitOnce = true;
        console.log('[draw] tools initialized');

        // Patch group.clearLayers to emit delete IDs when host clears via toolbar/site
        try {
            if (group && !group.__squadClearPatched) {
                const origClear = group.clearLayers && group.clearLayers.bind(group);
                if (typeof origClear === 'function') {
                    group.clearLayers = function () {
                        const ids = [];
                        try {
                            this.eachLayer && this.eachLayer(l => {
                                try {
                                    if (l && l._drawSyncId) ids.push(l._drawSyncId);
                                } catch (_) {
                                }
                            });
                        } catch (_) {
                        }
                        const ret = origClear();
                        try {
                            // Remove from local id map too so we stay consistent
                            const mapRef = (typeof window !== 'undefined' && window.squadMap) || null;
                            const idMap = mapRef && (mapRef.__squadmapsLayerIdMap || (mapRef.__squadmapsLayerIdMap = {}));
                            if (idMap && ids.length) ids.forEach((id) => {
                                try {
                                    delete idMap[id];
                                } catch (_) {
                                }
                            });
                        } catch (_) {
                        }
                        try {
                            if (ids.length && emit && emit.drawDelete) emit.drawDelete(ids);
                        } catch (_) {
                        }
                        return ret;
                    };
                    group.__squadClearPatched = true;
                }
            }
        } catch (_) {
        }

        // Watch for map swap and re-init if needed
        if (!__mapWatchTimer) {
            __mapWatchTimer = setInterval(() => {
                try {
                    if (window && window.squadMap && window.squadMap !== __mapRef) {
                        __drawInitOnce = false;
                        __mapRef = null;
                        start();
                    }
                } catch (_) {
                }
            }, 1000);
        }

        // Watch for toolbar disappearance and reattach if needed
        if (!__toolbarWatchTimer) {
            __toolbarWatchTimer = setInterval(() => {
                try {
                    ensureToolbarPresent(window && window.squadMap);
                } catch (_) {
                }
            }, 1000);
        }

        // Observe DOM mutations in the map container to reattach immediately
        observeToolbar(map);

        // Fast path: respond to local URL changes (map selection) by re-ensuring toolbar immediately
        try {
            if (!window.__squadmapsDrawMapPathListener) {
                window.addEventListener('squadmaps:mapPathChanged', () => {
                    try {
                        ensureToolbarPresent(window && window.squadMap);
                    } catch (_) {
                    }
                });
                window.__squadmapsDrawMapPathListener = true;
            }
        } catch (_) {
        }

        // Initialize undo/redo listener
        __addUndoListener();

        // Track mouse position over the map for keyboard-based edit/delete
        try {
            if (!__mapMouseMoveHandlerAdded) {
                map.on('mousemove', (mv) => {
                    try { __lastMouseLatLng = mv && mv.latlng ? mv.latlng : null; } catch (_) {}
                });
                __mapMouseMoveHandlerAdded = true;
            }
        } catch (_) {}

        // Attach hover listeners to existing and future layers
        try {
            group.eachLayer && group.eachLayer(l => { try { __addLayerHoverListener(l); } catch (_) {} });
            if (!group.__squadHoverAddBound) {
                group.on && group.on('layeradd', (ev) => { try { __addLayerHoverListener(ev && ev.layer); } catch (_) {} });
                group.on && group.on('layerremove', (ev) => { try { if (__hoveredLayer === (ev && ev.layer)) __hoveredLayer = null; } catch (_) {} });
                group.__squadHoverAddBound = true;
            }
        } catch (_) {}

        return true;
    };

    if (start()) return;

    const t = setInterval(() => {
        tries++;
        if (start()) {
            clearInterval(t);
            return;
        }
        // Give up after ~30s; harmless to stop
        if (tries > 120) clearInterval(t);
    }, 250);
}

function getDrawContext() {
    const map = (typeof window !== 'undefined' && window.squadMap) || null;
    if (!map || !window.L) return {map: null, group: null, idMap: {}};
    const group = ensureFeatureGroup(map);
    const idMap = map.__squadmapsLayerIdMap || (map.__squadmapsLayerIdMap = {});
    return {map, group, idMap};
}

export function applyRemoteDrawCreate(shape) {
    try {
        if (!shape || !shape.id || !shape.geojson) return;
        const {group, idMap} = getDrawContext();
        if (!group || idMap[shape.id]) return;
        const layer = geojsonToLayer(shape.geojson);
        if (layer) {
            layer._drawSyncId = shape.id;
            idMap[shape.id] = layer;
            group.addLayer(layer);
            __addLayerHoverListener(layer); // Ensure hover logic is attached
            // Keep editing disabled by default; edit toolbar will enable when active
            ensureLayerEditable(layer, false);
        }
    } catch (e) {
        console.warn('[draw] applyRemoteDrawCreate failed', e);
    }
}

export function applyRemoteDrawEdit(shapes) {
    try {
        if (!Array.isArray(shapes)) return;
        const {group, idMap} = getDrawContext();
        if (!group) return;
        shapes.forEach(s => {
            if (!s || !s.id || !s.geojson) return;
            const existing = idMap[s.id];
            if (!existing) {
                const l = geojsonToLayer(s.geojson);
                if (l) {
                    l._drawSyncId = s.id;
                    idMap[s.id] = l;
                    group.addLayer(l);
                    ensureLayerEditable(l, false);
                }
                return;
            }
            try {
                group.removeLayer(existing);
            } catch (_) {
            }
            const nl = geojsonToLayer(s.geojson);
            if (nl) {
                nl._drawSyncId = s.id;
                idMap[s.id] = nl;
                group.addLayer(nl);
                __addLayerHoverListener(nl); // Ensure hover logic is attached
                ensureLayerEditable(nl, false);
            }
        });
    } catch (e) {
        console.warn('[draw] applyRemoteDrawEdit failed', e);
    }
}

export function applyRemoteDrawDelete(ids) {
    try {
        if (!Array.isArray(ids)) return;
        const {group, idMap} = getDrawContext();
        if (!group) return;
        ids.forEach(id => {
            const l = idMap[id];
            if (l) {
                try {
                    group.removeLayer(l);
                } catch (_) {
                }
                delete idMap[id];
            }
        });
    } catch (e) {
        console.warn('[draw] applyRemoteDrawDelete failed', e);
    }
}

export function applyRemoteDrawProgress(p) {
    try {
        if (!p || !p.id) return;
        const map = (typeof window !== 'undefined' && window.squadMap) || null;
        if (!map || !window.L) return;
        const group = ensureProgressGroup(map);
        if (!group) return;
        const store = map.__squadmapsProgressMap || (map.__squadmapsProgressMap = {});

        // end/cleanup
        if (p.end) {
            const existing = store[p.id];
            if (existing) {
                try {
                    group.removeLayer(existing);
                } catch (_) {
                }
                delete store[p.id];
            }
            return;
        }

        const type = p.type || p.shapeType || 'polyline';
        let coords = [];
        if (Array.isArray(p.coords)) coords = p.coords;
        else if (Array.isArray(p.points)) coords = p.points;

        // Normalize to Leaflet latlngs
        let layer = store[p.id];
        const styleLine = {color: '#22d3ee', weight: 2, opacity: 0.85, dashArray: '6,4'};
        const stylePoly = {
            color: '#22d3ee',
            weight: 2,
            opacity: 0.85,
            fill: true,
            fillColor: '#22d3ee',
            fillOpacity: 0.12,
            dashArray: '6,4'
        };

        if (type === 'circle') {
            const center = p.center || (p.circle && p.circle.center) || null;
            const radius = Number(p.radius || (p.circle && p.circle.radius) || 0);
            if (!center || !Number.isFinite(radius)) return;
            const latlng = L.latLng(center.lat, center.lng);
            if (!layer) {
                layer = L.circle(latlng, Object.assign({}, stylePoly, {radius: Math.max(1, radius)}));
                group.addLayer(layer);
                store[p.id] = layer;
            } else {
                try {
                    layer.setLatLng(latlng);
                } catch (_) {
                }
                try {
                    layer.setRadius(Math.max(1, radius));
                } catch (_) {
                }
                try {
                    layer.setStyle(stylePoly);
                } catch (_) {
                }
            }
            layer.__lastSeen = Date.now();
        } else if (type === 'rectangle') {
            // expect coords as [sw, ne]
            if (!Array.isArray(coords) || coords.length < 2) return;
            const sw = L.latLng(coords[0].lat, coords[0].lng);
            const ne = L.latLng(coords[1].lat, coords[1].lng);
            const bounds = L.latLngBounds(sw, ne);
            if (!layer) {
                layer = L.rectangle(bounds, stylePoly);
                group.addLayer(layer);
                store[p.id] = layer;
            } else {
                try {
                    layer.setBounds(bounds);
                } catch (_) {
                }
                try {
                    layer.setStyle(stylePoly);
                } catch (_) {
                }
            }
            layer.__lastSeen = Date.now();
        } else if (type === 'polygon') {
            const latlngs = (coords || []).map(c => L.latLng(c.lat, c.lng));
            if (!layer) {
                layer = L.polygon(latlngs, stylePoly);
                group.addLayer(layer);
                store[p.id] = layer;
            } else {
                try {
                    layer.setLatLngs(latlngs);
                } catch (_) {
                }
                try {
                    layer.setStyle(stylePoly);
                } catch (_) {
                }
            }
            layer.__lastSeen = Date.now();
        } else {
            // polyline default
            const latlngs = (coords || []).map(c => L.latLng(c.lat, c.lng));
            if (!layer) {
                layer = L.polyline(latlngs, styleLine);
                group.addLayer(layer);
                store[p.id] = layer;
            } else {
                try {
                    layer.setLatLngs(latlngs);
                } catch (_) {
                }
                try {
                    layer.setStyle(styleLine);
                } catch (_) {
                }
            }
            layer.__lastSeen = Date.now();
        }

        // periodic cleanup
        if (!__progressCleanupTimer) {
            __progressCleanupTimer = setInterval(() => {
                try {
                    const now = Date.now();
                    Object.keys(store).forEach((k) => {
                        const l = store[k];
                        const last = l && l.__lastSeen || 0;
                        if (now - last > 3000) {
                            try {
                                group.removeLayer(l);
                            } catch (_) {
                            }
                            delete store[k];
                        }
                    });
                } catch (_) {
                }
            }, 1500);
        }
    } catch (e) {
        console.warn('[draw] applyRemoteDrawProgress failed', e);
    }
}

// Public helper to re-ensure the toolbar from outside this module
export function recheckDrawToolbar() {
    try {
        const W = __hostWindow();
        let map = (typeof W !== 'undefined' && W.squadMap) || null;
        if (!map) {
            map = __fallbackFindExistingMap();
        }
        if (!map) {
            try {
                console.log('[draw] recheck: no map');
            } catch (_) {
            }
            return;
        }
        if (!__isActiveMapPath()) {
            try {
                console.log('[draw] recheck: skip on non-map path');
            } catch (_) {
            }
            return;
        }
        const tryEnsure = (attempt = 0) => {
            try {
                if (!W.L || !W.L.Control || !W.L.Control.Draw) {
                    if (attempt === 0) {
                        try {
                            console.log('[draw] recheck: Draw not ready, requesting assets');
                        } catch (_) {
                        }
                    }
                    ensureLeafletDrawAssets();
                    if (attempt < 20) return void setTimeout(() => tryEnsure(attempt + 1), 200);
                    try {
                        console.log('[draw] recheck: giving up waiting for Draw');
                    } catch (_) {
                    }
                    return;
                }
                ensureFeatureGroup(map);
                ensureProgressGroup(map);
                ensureToolbarPresent(map);
                observeToolbar(map);
                try {
                    console.log('[draw] recheck: toolbar ensured');
                } catch (_) {
                }
            } catch (_) {
            }
        };
        tryEnsure(0);
    } catch (_) {
    }
}
