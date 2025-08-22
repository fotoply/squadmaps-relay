// ==UserScript==
// @name         Squad Maps sync
// @namespace    http://tampermonkey.net/
// @version      2025-08-28.5
// @description  Synchronize SquadMaps between multiple computers with drawing support
// @author       You
// @match        https://squadmaps.com/*
// @require      https://cdn.socket.io/4.8.1/socket.io.min.js
// @connect      minecraft-alt.fotoply.dev
// @license      MIT
// @homepageURL  https://minecraft-alt.fotoply.dev
// @updateURL    https://minecraft-alt.fotoply.dev:3000/tampermonkey-script.js
// @downloadURL  https://minecraft-alt.fotoply.dev:3000/tampermonkey-script.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=squadmaps.com
// @grant        none
// @run-at       document-body
// ==/UserScript==

(function () {
    'use strict';

    // Hard suppression flag for native context menu during active drawing
    let suppressContextMenuActive = false;
    window.addEventListener('contextmenu', e => {
        // Always block context menu inside the map container (user request)
        try {
            if (window.squadMap && squadMap._container && squadMap._container.contains(e.target)) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        } catch (_) {
        }
        // Fallback (legacy) suppression when drawing active
        if (!suppressContextMenuActive) return;
        if (!window.squadMap || !squadMap._container) return;
        try {
            const r = squadMap._container.getBoundingClientRect();
            const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            if (inside) {
                e.preventDefault();
                e.stopPropagation();
            }
        } catch (_) {
        }
    }, true);

    console.log('[sync] Injecting SquadMaps sync script');

    // ---------------- State ----------------
    window.squadMap = undefined; // Leaflet map instance captured via init hook
    window.currentMap = undefined; // current path+query
    let hasReceivedState = false;
    let pendingReplayClicks = [];
    let serverCurrentMap = null;
    let lastEmittedMap = null;
    let suppressNextMapEmit = false;
    const SUPPRESS_KEY = 'squadmapsSuppressMapEmit';
    // New: view sync state
    let isApplyingRemoteView = false; // suppress echo on moveend when applying remote
    let viewHandlersAttached = false;  // ensure once-per-map init
    let pendingInitialView = null;     // apply when map ready
    let syncViewBtn;                   // Sync View button ref
    let applyViewBtn;                  // Apply View button ref (manual initial view)

    let drawnItems; // L.FeatureGroup for drawings
    const layerIdMap = {}; // drawingId -> layer
    const DRAW_TOOLBAR_OFFSET_PX = 100;
    let clickProxyDiv; // overlay used (only for certain tools)
    let drawControlRef; // reference to control/options for fallback enabling
    let drawCreatedHandlerAttached = false; // added
    let lastCreatedGeoJSONString = null;   // added
    let customDraw = null; // manual fallback state
    let mapDomDebugAttached = false; // prevent attach duplication
    let editBlockers = []; // overlay elements whose pointer events are disabled during edit
    let removeModeActive = false; // global delete mode flag (moved from inside setupDrawingTools)
    let continuousActiveType = null; // NEW: track continuous drawing tool type
    let continuousModeEnabled = true; // NEW: user-toggle for continuous mode
    const CONT_KEY = 'squadmapsContinuousMode';
    try {
        const stored = localStorage.getItem(CONT_KEY);
        if (stored !== null) continuousModeEnabled = stored === '1';
    } catch (_) {
    }
    let lastDrawButtonSelector = null; // added tracking
    let currentDrawCreationOccurred = false; // set true on draw:created for current session
    let currentDrawSessionId = 0;            // increment each drawstart & manual toolbar click
    let lastToolbarClickAt = 0;              // timestamp of last user toolbar click
    let drawToolEngaged = false;             // true while a draw tool is active
    let activeDrawHandler = null;            // reference to current draw handler
    let activeDrawLayerType = null;          // layer type string for current handler

    // NEW: transient in-progress drawing state (live preview sync)
    let progressItems;                       // separate group for remote progress overlays
    const inProgressLayers = {};             // id -> temp layer (now stores { layer, type, lastSeen })
    let currentProgressId = null;            // sender-side id per drawing gesture
    let currentProgressType = null;          // 'polyline' | 'polygon'
    let __progressInterval = null;           // sampler timer while drawing
    let __progressLastSig = '';              // change-dedup signature
    let __progressCleanupTimer = null;       // periodic cleanup of stale previews

    // NEW: Marker tool (Font Awesome) state and helpers
    const MARKER_ICON_KEY = 'squadmapsMarkerIcon';
    const DEFAULT_MARKER_ICON = 'location-dot';
    const AVAILABLE_MARKER_ICONS = [
        'location-dot',
        'map-pin',
        'flag',
        'star',
        'triangle-exclamation',
        'crosshairs',
        'skull-crossbones',
        'circle'
    ];
    let currentMarkerIcon = DEFAULT_MARKER_ICON;

    function loadMarkerIconChoice() {
        try {
            const v = localStorage.getItem(MARKER_ICON_KEY);
            if (v && AVAILABLE_MARKER_ICONS.includes(v)) currentMarkerIcon = v;
        } catch (_) {
        }
    }

    function saveMarkerIconChoice() {
        try {
            localStorage.setItem(MARKER_ICON_KEY, currentMarkerIcon);
        } catch (_) {
        }
    }

    function ensureFontAwesomeOnce() {
        if (document.getElementById('squadmaps-fa')) return;
        const link = document.createElement('link');
        link.id = 'squadmaps-fa';
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
        document.head.appendChild(link);
    }

    // NEW: ensure our FA marker CSS baseline (remove default Leaflet div-icon border/bg)
    function ensureFaMarkerCssOnce() {
        if (document.getElementById('squadmaps-fa-marker-css')) return;
        const st = document.createElement('style');
        st.id = 'squadmaps-fa-marker-css';
        st.textContent = `.squad-fa-marker-wrap{background:transparent!important;border:0!important;}
.squad-fa-marker-wrap .squad-fa-marker{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.squad-fa-marker-wrap i{pointer-events:none;}`;
        document.head.appendChild(st);
    }

    function buildFaDivIcon(iconName, colorHex) {
        ensureFontAwesomeOnce();
        ensureFaMarkerCssOnce();
        const icon = iconName || currentMarkerIcon || DEFAULT_MARKER_ICON;
        const color = (colorHex && /^#?[0-9a-fA-F]{6}$/.test(colorHex)) ? (colorHex[0] === '#' ? colorHex : ('#' + colorHex)) : (userColor || '#ff6600');
        // Visual tuning: slightly smaller container + glyph, precise anchor so placement matches cursor
        const size = 48; // px box for the marker (25% smaller than 64)
        const fontSize = 35; // px glyph size inside the box
        const centerAnchored = icon === 'crosshairs' || icon === 'circle';
        const anchor = centerAnchored ? [size / 2, size / 2] : [Math.round(size / 2), size - 5]; // center for crosshair/circle; bottom-center otherwise
        const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${icon}" style="color:${color};font-size:${fontSize}px;line-height:1"></i></div>`;
        return L.divIcon({
            className: 'leaflet-div-icon squad-fa-marker-wrap',
            html,
            iconSize: [size, size],
            iconAnchor: anchor
        });
    }

    function applyMarkerIconToLayerIfNeeded(layer) {
        try {
            if (layer instanceof L.Marker) {
                const col = userColor || '#ff6600';
                layer.setIcon(buildFaDivIcon(currentMarkerIcon, col));
                layer.__faIconName = currentMarkerIcon;
                layer.__faColor = col;
            }
        } catch (_) {
        }
    }

    let markerPickerBtn, markerPickerPanel;

    function buildMarkerPickerUI() {
        ensureFontAwesomeOnce();
        loadMarkerIconChoice();
        const markerBtn = document.querySelector('.leaflet-draw-draw-marker');
        if (!markerBtn) {
            setTimeout(buildMarkerPickerUI, 400);
            return;
        }
        if (document.getElementById('squadmaps-marker-picker-btn')) {
            updateMarkerPickerVisual();
            return;
        }
        const btn = document.createElement('a');
        btn.id = 'squadmaps-marker-picker-btn';
        btn.href = '#';
        btn.title = 'Choose marker icon';
        btn.innerHTML = `<i class="fa-solid fa-${currentMarkerIcon}" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>`;
        Object.assign(btn.style, {
            width: '30px',
            height: '30px',
            display: 'block',
            background: '#171718',
            color: '#fff'
        });
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleMarkerPanel();
        });
        markerBtn.parentElement && markerBtn.parentElement.insertBefore(btn, markerBtn.nextSibling);
        markerPickerBtn = btn;
        const panel = document.createElement('div');
        panel.id = 'squadmaps-marker-picker-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            zIndex: 1000,
            background: '#222',
            color: '#fff',
            padding: '6px',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            display: 'none'
        });
        const grid = document.createElement('div');
        Object.assign(grid.style, {display: 'grid', gridTemplateColumns: 'repeat(4, 28px)', gap: '6px'});
        AVAILABLE_MARKER_ICONS.forEach(name => {
            const a = document.createElement('a');
            a.href = '#';
            a.setAttribute('data-icon', name);
            a.innerHTML = `<i class="fa-solid fa-${name}"></i>`;
            Object.assign(a.style, {
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: name === currentMarkerIcon ? '#2563eb' : '#171718',
                border: '1px solid #2a2a2b',
                borderRadius: '4px',
                color: '#fff'
            });
            a.addEventListener('click', (e) => {
                e.preventDefault();
                currentMarkerIcon = name;
                saveMarkerIconChoice();
                updateMarkerPickerVisual();
                if (drawControlRef && drawControlRef.options && drawControlRef.options.draw) {
                    try {
                        drawControlRef.options.draw.marker = drawControlRef.options.draw.marker || {};
                        drawControlRef.options.draw.marker.icon = buildFaDivIcon(currentMarkerIcon, userColor);
                    } catch (_) {
                    }
                }
            });
            grid.appendChild(a);
        });
        panel.appendChild(grid);

        function positionPanel() {
            try {
                const r = btn.getBoundingClientRect();
                panel.style.left = (r.left) + 'px';
                panel.style.top = (r.bottom + 6) + 'px';
            } catch (_) {
            }
        }

        positionPanel();
        window.addEventListener('resize', positionPanel);
        document.body.appendChild(panel);
        markerPickerPanel = panel;
        document.addEventListener('click', (ev) => {
            if (!markerPickerPanel || markerPickerPanel.style.display === 'none') return;
            if (ev.target === btn || btn.contains(ev.target)) return;
            if (markerPickerPanel.contains(ev.target)) return;
            markerPickerPanel.style.display = 'none';
        }, true);
        if (!document.getElementById('squadmaps-marker-picker-css')) {
            const st = document.createElement('style');
            st.id = 'squadmaps-marker-picker-css';
            st.textContent = `#squadmaps-marker-picker-btn{border:1px solid #2a2a2b !important;box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset;}#squadmaps-marker-picker-btn:hover{background:#1f1f20 !important;}#squadmaps-marker-picker-panel i{font-size:16px;}`;
            document.head.appendChild(st);
        }
        updateMarkerPickerVisual();
    }

    function toggleMarkerPanel() {
        if (!markerPickerPanel) return;
        markerPickerPanel.style.display = (markerPickerPanel.style.display !== 'none') ? 'none' : 'block';
    }

    function updateMarkerPickerVisual() {
        if (markerPickerBtn) markerPickerBtn.innerHTML = `<i class=\"fa-solid fa-${currentMarkerIcon}\" aria-hidden=\"true\" style=\"display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;\"></i>`;
        if (markerPickerPanel) markerPickerPanel.querySelectorAll('a[data-icon]').forEach(a => {
            const name = a.getAttribute('data-icon');
            a.style.background = (name === currentMarkerIcon) ? '#2563eb' : '#171718';
        });
    }

    // Helper: run callback once squadMap + drawnItems are ready; retries with backoff
    function runWhenDrawReady(fn, retries = 20, delay = 180) {
        if (drawnItems && squadMap) {
            try {
                fn();
            } catch (err) {
                console.warn('[sync] draw-ready fn error', err);
            }
            return;
        }
        if (retries <= 0) return;
        if (!squadMap) { /* try map hook */
            ensureMapHooked && ensureMapHooked();
        }
        setupDrawingTools();
        setTimeout(() => runWhenDrawReady(fn, retries - 1, Math.min(delay + 40, 400)), delay);
    }

    // Delete mode helper fns (moved global so onDrawCreated can access)
    function onLayerRemoveClick(e) {
        if (!removeModeActive) return;
        const layer = this;
        try {
            if (e?.originalEvent) {
                e.originalEvent.stopPropagation();
                e.originalEvent.preventDefault();
            }
        } catch (_) {
        }
        const id = layer._drawSyncId;
        if (window.__squadDrawVerbose) console.log('[draw-debug] layer remove click id=', id, 'type=', layer instanceof L.Circle ? 'circle' : 'other');
        try {
            drawnItems.removeLayer(layer);
        } catch (_) {
        }
        if (id) {
            delete layerIdMap[id];
            socket.emit('draw delete', [id]);
            dlog('direct delete (handler) emitted', id);
        }
    }

    function attachRemoveHandler(layer) {
        if (!layer || layer.__removeModeHandlerAttached) return;
        layer.__removeModeHandlerAttached = true;
        layer.on && layer.on('click', onLayerRemoveClick);
        if (window.__squadDrawVerbose) console.log('[draw-debug] attach remove handler', layer._drawSyncId, layer instanceof L.Circle ? 'circle' : 'other');
    }

    function detachRemoveHandler(layer) {
        if (!layer || !layer.__removeModeHandlerAttached) return;
        layer.off && layer.off('click', onLayerRemoveClick);
        delete layer.__removeModeHandlerAttached;
    }

    function refreshRemoveHandlers() {
        if (!drawnItems) return;
        drawnItems.eachLayer(l => {
            if (removeModeActive) attachRemoveHandler(l); else detachRemoveHandler(l);
        });
    }

    function applyRemoveModeStyling(on) {
        if (!drawnItems) return;
        drawnItems.eachLayer(l => {
            try {
                if (l.setStyle) {
                    if (on) {
                        if (!l.__prevStyleForDelete) {
                            l.__prevStyleForDelete = Object.assign({}, l.options);
                        }
                        l.setStyle({dashArray: '6,6', opacity: 0.85});
                    } else if (l.__prevStyleForDelete) {
                        l.setStyle({
                            dashArray: l.__prevStyleForDelete.dashArray || null,
                            opacity: l.__prevStyleForDelete.opacity || 1
                        });
                    }
                }
            } catch (_) {
            }
        });
    }

    function layerRoughHit(layer, latlng, layerPoint) {
        try {
            if (layer instanceof L.Marker) {
                const p = squadMap.latLngToLayerPoint(layer.getLatLng());
                if (layerPoint) return p.distanceTo(layerPoint) < 12;
                const q = squadMap.latLngToLayerPoint(latlng);
                return p.distanceTo(q) < 12;
            } else if (layer instanceof L.Circle) {
                // Primary: use internal pixel point/radius (works with Canvas renderer & custom CRS)
                if (layerPoint && layer._point && typeof layer._radius === 'number') {
                    const hitCanvas = layer._point.distanceTo(layerPoint) <= layer._radius;
                    if (window.__squadDrawVerbose) console.log('[draw-debug] circle canvas hit rPx=', layer._radius, 'hit=', hitCanvas);
                    if (hitCanvas) return true;
                }
                // Secondary precise pixel-based estimation via latLng conversions (may fail in custom CRS)
                if (layerPoint) {
                    const center = layer.getLatLng();
                    const centerPt = squadMap.latLngToLayerPoint(center);
                    let onePxLatLng;
                    try {
                        onePxLatLng = squadMap.layerPointToLatLng(centerPt.add([1, 0]));
                    } catch (_) {
                        onePxLatLng = null;
                    }
                    if (onePxLatLng) {
                        const mPerPx = center.distanceTo(onePxLatLng) || 1; // avoid div0
                        const rPxEst = layer.getRadius() / mPerPx;
                        const hitPxEst = centerPt.distanceTo(layerPoint) <= rPxEst;
                        if (window.__squadDrawVerbose) console.log('[draw-debug] circle pixel-est hit rPxEst=', rPxEst.toFixed(2), 'hit=', hitPxEst);
                        if (hitPxEst) return true;
                    }
                }
                // Fallback to geographic distance (least reliable in custom CRS)
                const dist = layer.getLatLng().distanceTo(latlng);
                const r = layer.getRadius();
                if (window.__squadDrawVerbose) console.log('[draw-debug] circle geo hit dist=', dist, 'r=', r, 'hit=', dist <= r);
                return dist <= r;
            } else if (layer.getBounds && layer.getBounds().contains(latlng)) {
                return true;
            }
        } catch (_) {
        }
        return false;
    }

    // ---- User color persistence ----
    const COLOR_KEY = 'squadmapsUserColor';
    const RECENT_KEY = 'squadmapsRecentColors';
    let userColor = null;
    let recentColors = [];

    function loadRecentColors() {
        try {
            recentColors = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        } catch (_) {
            recentColors = [];
        }
        if (!Array.isArray(recentColors)) recentColors = []; // sanitize
        recentColors = recentColors.filter(c => /^#[0-9a-fA-F]{6}$/.test(c.toLowerCase()));
    }

    function saveRecentColors() {
        try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors.slice(0, 10)));
        } catch (_) {
        }
    }

    function randomColor() {
        return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    }

    function initUserColor() {
        userColor = localStorage.getItem(COLOR_KEY);
        if (!userColor || !/^#?[0-9a-fA-F]{6}$/.test(userColor)) {
            userColor = randomColor();
            localStorage.setItem(COLOR_KEY, userColor);
        }
        if (userColor[0] !== '#') userColor = '#' + userColor;
        loadRecentColors();
        // ensure current color in list
        addRecentColor(userColor, true);
    }

    function setUserColor(c) {
        if (!c) return;
        if (c[0] !== '#') c = '#' + c;
        if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
        userColor = c.toLowerCase();
        localStorage.setItem(COLOR_KEY, userColor);
        addRecentColor(userColor);
        if (colorSwatch) colorSwatch.style.background = userColor;
        if (colorInput && colorInput.value.toLowerCase() !== userColor) colorInput.value = userColor;
        // Update the toolbar button & draw control shape options for future drawings
        applyLiveColor(userColor);
        updateRecentColorsUI();
        updateColorButtonVisual(); // NEW
    }

    function applyLiveColor(c) {
        if (!c) return;
        if (c[0] !== '#') c = '#' + c;
        if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
        const col = c.toLowerCase();
        if (colorPickerWrapper) colorPickerWrapper.style.backgroundColor = col; // changed to backgroundColor
        updateColorButtonVisual(); // keep icon contrast updated during live preview
        try {
            if (drawControlRef && drawControlRef.options && drawControlRef.options.draw) {
                const d = drawControlRef.options.draw;
                ['rectangle', 'circle', 'polygon', 'polyline'].forEach(k => {
                    if (d[k] && d[k].shapeOptions) {
                        d[k].shapeOptions.color = col;
                        if (d[k].shapeOptions.fillColor !== undefined) d[k].shapeOptions.fillColor = col;
                        d[k].shapeOptions.opacity = 1; // ensure full line opacity
                    }
                });
                // ensure future marker placements also reflect the live color
                if (d.marker) {
                    d.marker.icon = buildFaDivIcon(currentMarkerIcon, col);
                }
            }
        } catch (_) {
        }
    }

    function addRecentColor(c, silent) {
        c = c.toLowerCase();
        if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
        loadRecentColors();
        if (recentColors.includes(c)) {
            if (!silent) dlog('color already in recent', c);
            return;
        }
        recentColors = [c, ...recentColors];
        if (recentColors.length > 10) recentColors = recentColors.slice(0, 10);
        saveRecentColors();
        if (!silent) dlog('added recent color', c);
    }

    let colorPickerWrapper, colorInput, colorSwatch, recentPalette; // existing vars
    let colorButtonIconSpan; // NEW: holds icon span for color picker

    function updateColorButtonVisual() {
        if (!colorPickerWrapper) return;
        const col = userColor || '#888888';
        colorPickerWrapper.style.background = col;
        colorPickerWrapper.style.backgroundImage = 'none';
        try {
            const hex = col.replace('#', '');
            const r = parseInt(hex.substr(0, 2), 16);
            const g = parseInt(hex.substr(2, 2), 16);
            const b = parseInt(hex.substr(4, 2), 16);
            const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            const iconColor = luma > 0.58 ? '#111' : '#fff';
            if (colorButtonIconSpan) {
                let ico = colorButtonIconSpan.querySelector('i.fa-eye-dropper, i.fa-eyedropper, i.fa-solid.fa-eye-dropper');
                if (!ico) {
                    ico = document.createElement('i');
                    // Prefer FA6 solid, fallback classes for older versions
                    ico.className = 'fa-solid fa-eye-dropper';
                    ico.style.pointerEvents = 'none';
                    colorButtonIconSpan.innerHTML = '';
                    colorButtonIconSpan.appendChild(ico);
                }
                ico.style.color = iconColor;
            }
        } catch (_) {
        }
    }

    function buildColorPickerUI() {
        // Integrate color picker into Leaflet.Draw edit toolbar (edit/delete group)
        if (document.getElementById('squadmaps-color-button')) {
            // Update background if color changed
            const existingBtn = document.getElementById('squadmaps-color-button');
            if (existingBtn) existingBtn.style.backgroundColor = userColor;
            updateRecentColorsUI();
            updateColorButtonVisual();
            return;
        }
        const toolbars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
        let targetBar = null;
        toolbars.forEach(tb => {
            if (!targetBar && (tb.querySelector('.leaflet-draw-edit-edit') || tb.querySelector('[class*="leaflet-draw-edit-edit"]'))) targetBar = tb; // edit toolbar
        });
        if (!targetBar) {
            setTimeout(buildColorPickerUI, 400);
            return;
        }
        const btn = document.createElement('a');
        btn.id = 'squadmaps-color-button';
        btn.href = '#';
        btn.title = 'Drawing color';
        Object.assign(btn.style, {
            position: 'relative',
            width: '30px',
            height: '30px',
            display: 'block',
            backgroundColor: userColor, // changed
            boxSizing: 'border-box',
            border: 'none',
            cursor: 'pointer',
            padding: '0'
        });
        const inner = document.createElement('span');
        colorButtonIconSpan = inner; // remember ref
        Object.assign(inner.style, {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '16px',
            lineHeight: '1',
            border: '2px solid rgba(255,255,255,0.35)',
            boxSizing: 'border-box',
            pointerEvents: 'none'
        });
        btn.appendChild(inner);
        // Ensure Font Awesome loaded for eyedropper icon
        (function ensureFontAwesome() {
            if (document.getElementById('squadmaps-fa')) return;
            const link = document.createElement('link');
            link.id = 'squadmaps-fa';
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
            document.head.appendChild(link);
        })();
        // Full-size transparent color input overlay (captures click directly)
        const input = document.createElement('input');
        input.type = 'color';
        input.value = userColor;
        Object.assign(input.style, {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: '0',
            cursor: 'pointer',
            border: '0',
            padding: '0',
            margin: '0',
            background: 'transparent'
        });
        // Live preview while picker open (no recent update)
        input.addEventListener('input', e => {
            applyLiveColor(e.target.value);
        });
        // Commit only when picker closed (change event)
        input.addEventListener('change', e => {
            setUserColor(e.target.value);
        });
        btn.appendChild(input);
        targetBar.appendChild(btn);
        colorPickerWrapper = btn;
        colorInput = input;
        colorSwatch = null;
        // Recent colors container
        const palette = document.createElement('div');
        palette.id = 'squadmaps-recent-colors';
        Object.assign(palette.style, {
            display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '4px 2px', background: '#222',
            borderRadius: '4px', marginTop: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
        });
        targetBar.parentElement?.appendChild(palette); // place under toolbar block
        recentPalette = palette;
        updateRecentColorsUI();
        updateColorButtonVisual(); // initial icon render
        // Continuous mode toggle button
        if (!document.getElementById('squadmaps-continuous-button')) {
            const contBtn = document.createElement('a');
            contBtn.id = 'squadmaps-continuous-button';
            contBtn.href = '#';
            contBtn.title = 'Toggle continuous drawing (stay in tool after finishing)';
            contBtn.innerHTML = '<i class="fa-solid fa-infinity" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>';
            Object.assign(contBtn.style, {
                width: '30px',
                height: '30px',
                display: 'block',
                background: '#171718',
                color: '#fff',
                textDecoration: 'none'
            });

            function syncCont() {
                contBtn.className = continuousModeEnabled ? 'active' : '';
                // Remove inline background assignment to allow CSS to control appearance fully
            }

            contBtn.addEventListener('click', e => {
                e.preventDefault();
                continuousModeEnabled = !continuousModeEnabled;
                try {
                    localStorage.setItem(CONT_KEY, continuousModeEnabled ? '1' : '0');
                } catch (_) {
                }
                syncCont();
            });
            syncCont();
            targetBar.appendChild(contBtn);
            if (!document.getElementById('squadmaps-continuous-css')) {
                const st = document.createElement('style');
                st.id = 'squadmaps-continuous-css';
                st.textContent = '#squadmaps-continuous-button.active{box-shadow:0 0 0 2px #fff inset;}';
                document.head.appendChild(st);
            }
        }
        if (!document.getElementById('squadmaps-color-toolbar-css')) {
            const st = document.createElement('style');
            st.id = 'squadmaps-color-toolbar-css';
            st.textContent = `.leaflet-draw-toolbar a#squadmaps-color-button { box-shadow:none; position:relative; background-image:none!important; }
.leaflet-draw-toolbar a#squadmaps-color-button:hover { filter:brightness(1.08); }
.leaflet-draw-toolbar a#squadmaps-color-button:active { filter:brightness(0.92); }
#squadmaps-color-button span i { font-size:16px; display:block; }
#squadmaps-recent-colors { width:112px; }
#squadmaps-recent-colors .squadmaps-recent-color { width:20px; height:20px; border:1px solid #555; cursor:pointer; box-sizing:border-box; }
#squadmaps-recent-colors .squadmaps-recent-color:hover { outline:2px solid #fff; }
#squadmaps-recent-colors .squadmaps-recent-color.active { outline:2px solid #0f0; }
/* Continuous button dedicated styling */
#squadmaps-continuous-button {background:#171718 !important; border:1px solid #2a2a2b !important; color:#fff !important; filter:none !important; box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset; transition:background .18s, box-shadow .18s, transform .16s;}
#squadmaps-continuous-button:hover {background:#1f1f20 !important;}
#squadmaps-continuous-button.active {background:#16a34a !important; border-color:#1fd367 !important; box-shadow:0 0 0 2px #ffffff33 inset,0 0 10px 2px #16ff8b99,0 0 0 1px #0c4024; transform:translateY(-1px);}
/* Remove native focus rings/outline on the embedded color input to avoid black outline bleed */
#squadmaps-color-button input[type="color"]{outline:none !important;border:none !important;box-shadow:none !important;-webkit-appearance:none;-moz-appearance:none;appearance:none;}`;
            document.head.appendChild(st);
        }
        (function ensureToolbarContrast() {
            const css = `.leaflet-bar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button), .leaflet-draw-toolbar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button){background-color:#171718 !important;color:#fff !important;border:1px solid #2a2a2b !important;box-shadow:0 1px 2px #000c !important;outline:none !important;}
.leaflet-bar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):hover, .leaflet-draw-toolbar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):hover {background-color:#1f1f20 !important;}
.leaflet-bar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):active, .leaflet-draw-toolbar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):active {background-color:#101010 !important;}
/* Remove harsh black focus outlines; use subtle inner focus for accessibility */
.leaflet-bar a:focus, .leaflet-draw-toolbar a:focus {outline:none !important; box-shadow:0 0 0 2px #3b82f633 inset, 0 1px 2px #000c !important;}
.leaflet-draw-toolbar a.leaflet-draw-toolbar-button-enabled, .leaflet-draw-toolbar a.leaflet-draw-toolbar-button-selected {background-color:#2563eb !important;border-color:#3b82f6 !important;box-shadow:0 0 0 2px #ffffff33 inset,0 0 6px 2px #1d4ed899 !important;}
/* Override Leaflet touch-mode container border that causes wide black outlines */
.leaflet-touch .leaflet-bar, .leaflet-touch .leaflet-control-layers { border:none !important; box-shadow:none !important; }`;
            let st2 = document.getElementById('squadmaps-toolbar-bg-fix');
            if (!st2) {
                st2 = document.createElement('style');
                st2.id = 'squadmaps-toolbar-bg-fix';
                document.head.appendChild(st2);
            }
            if (st2.textContent !== css) st2.textContent = css;
        })();
    }

    function updateRecentColorsUI() {
        if (!recentPalette) return;
        recentPalette.innerHTML = '';
        loadRecentColors();
        recentColors.forEach(c => {
            const b = document.createElement('div');
            b.className = 'squadmaps-recent-color' + (c.toLowerCase() === userColor ? ' active' : '');
            b.style.background = c;
            b.title = 'Use ' + c;
            b.addEventListener('click', e => {
                e.preventDefault();
                setUserColor(c);
            });
            recentPalette.appendChild(b);
        });
    }

    function attachColorPickerToMap() { /* no-op in toolbar mode */
    }

    // --- Manual fallback implementation ---
    function manualStart(type) {
        if (!squadMap) return;
        if (customDraw) manualCancel('restart');
        console.log('[manual] start', type);
        customDraw = {type, points: [], layer: null, markers: []};
        try {
            squadMap.dragging.disable();
        } catch (_) {
        }
        showManualHint();
    }

    function manualAdd(latlng) {
        if (!customDraw || !latlng) return;
        customDraw.points.push(latlng);
        if (!customDraw.layer) {
            if (customDraw.type === 'polyline') customDraw.layer = L.polyline([latlng], {
                color: userColor,
                weight: 3,
                interactive: true
            }).addTo(squadMap);
            else customDraw.layer = L.polygon([[latlng]], {
                color: userColor,
                weight: 2,
                fillOpacity: 0.50,
                fillColor: userColor,
                interactive: true
            }).addTo(squadMap);
        } else {
            if (customDraw.type === 'polyline') customDraw.layer.setLatLngs(customDraw.points.slice());
            else customDraw.layer.setLatLngs([customDraw.points.slice()]);
        }
        try {
            const mk = L.circleMarker(latlng, {
                radius: 4,
                color: userColor,
                weight: 2,
                fillColor: userColor,
                fillOpacity: 0.9
            }).addTo(squadMap);
            customDraw.markers.push(mk);
        } catch (_) {
        }
        updateManualHint();
    }

    function manualFinish() {
        if (!customDraw) return;
        const n = customDraw.points.length;
        if ((customDraw.type === 'polyline' && n < 2) || (customDraw.type === 'polygon' && n < 3)) return manualCancel('not-enough');
        drawnItems = drawnItems || new L.FeatureGroup().addTo(squadMap);
        drawnItems.addLayer(customDraw.layer);
        ensureLayerEditable(customDraw.layer);
        const editModeActive = !!document.querySelector('.leaflet-draw-edit-edit.leaflet-draw-edit-edit-active');
        if (editModeActive) {
            try {
                customDraw.layer.editing && customDraw.layer.editing.enable();
            } catch (_) {
            }
        } else {
            try {
                customDraw.layer.editing && customDraw.layer.editing.disable && customDraw.layer.editing.disable();
            } catch (_) {
            }
        }
        const geojson = layerToSerializable(customDraw.layer);
        const id = generateId();
        customDraw.layer._drawSyncId = id;
        layerIdMap[id] = customDraw.layer;
        console.log('[manual] emit create', id, geojson.properties.shapeType, 'points=', n);
        socket.emit('draw create', {id, geojson});
        manualCleanup();
    }

    function manualCancel(reason) {
        if (!customDraw) return;
        console.log('[manual] cancel', reason || '');
        if (customDraw.layer) {
            try {
                squadMap.removeLayer(customDraw.layer);
            } catch (_) {
            }
        }
        manualCleanup();
    }

    function manualCleanup() {
        (customDraw.markers || []).forEach(m => {
            try {
                squadMap.removeLayer(m);
            } catch (_) {
            }
        });
        try {
            squadMap.dragging.enable();
        } catch (_) {
        }
        hideManualHint();
        customDraw = null;
    }

    // Simple on-screen hint
    let manualHintEl;

    function showManualHint() {
        if (manualHintEl) return;
        manualHintEl = document.createElement('div');
        manualHintEl.id = 'squadmaps-manual-hint';
        Object.assign(manualHintEl.style, {
            position: 'fixed',
            top: '8px',
            right: '8px',
            zIndex: 9999,
            background: '#222',
            color: '#fff',
            padding: '6px 10px',
            font: '12px monospace',
            borderRadius: '4px',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)'
        });
        manualHintEl.textContent = 'Manual ' + customDraw.type + ' mode: click to add points, Enter/dbl/right-click to finish, Esc to cancel';
        document.body.appendChild(manualHintEl);
    }

    function updateManualHint() {
        if (manualHintEl && customDraw) manualHintEl.textContent = 'Manual ' + customDraw.type + ' points: ' + customDraw.points.length + ' (Enter/dbl/right-click finish, Esc cancel)';
    }

    function hideManualHint() {
        if (manualHintEl) {
            manualHintEl.remove();
            manualHintEl = null;
        }
    }

    // Manual mode event listeners
    window.addEventListener('click', e => {
        if (!customDraw) return;
        if (e.button !== 0) return; // only left click
        if (!squadMap || !squadMap._container.contains(e.target)) return;
        const ll = squadMap.mouseEventToLatLng(e);
        if (ll) {
            e.stopPropagation();
            e.preventDefault();
            manualAdd(ll);
        }
    }, true);
    window.addEventListener('dblclick', e => {
        if (customDraw) {
            e.preventDefault();
            manualFinish();
        }
    }, true);
    window.addEventListener('contextmenu', e => {
        if (customDraw) {
            e.preventDefault();
            manualFinish();
        }
    }, true);
    window.addEventListener('keydown', e => {
        if (!customDraw) return;
        if (e.key === 'Escape') {
            manualCancel('esc');
        } else if (e.key === 'Enter') {
            manualFinish();
        }
    }, true);

    // Debug / diagnostics
    const DEBUG_DRAW = true; // base always minimal
    window.__squadDrawVerbose = false; // toggle for very noisy logs
    // noinspection JSUnusedLocalSymbols not unused, used in debug mode
    function vlog(...a) {
        if (window.__squadDrawVerbose) console.log('[draw-verbose]', ...a);
    }

    function dlog(...a) {
        if (DEBUG_DRAW) console.log('[draw-debug]', ...a);
    }

    let lastPointer = {x: 0, y: 0};

    // ---------------- Socket ----------------
    const socket = io('https://minecraft-alt.fotoply.dev:3000', {
        transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 200
    });

    // ---------------- Presence (UI + state) ----------------
    const USERNAME_KEY = 'squadmapsUsername';
    let mySocketId = null;
    let followingUserId = null;
    const FOLLOW_KEY = 'squadmapsFollowUser';
    let presenceUsers = {}; // id -> { id, name, tool, cursor, view, marker }
    let presenceLayer = null; // L.LayerGroup
    let presencePanelEl = null; // container DOM
    let presenceHandlersAttached = false;

    function ensurePresenceLayer() {
        if (presenceLayer && presenceLayer._map === squadMap) return;
        if (!squadMap) return;
        if (presenceLayer && presenceLayer._map && presenceLayer._map !== squadMap) {
            try {
                presenceLayer.remove();
            } catch (_) {
            }
            presenceLayer = null;
        }
        presenceLayer = L.layerGroup().addTo(squadMap);
    }

    function colorForUser(id, name) {
        const s = String(id || name || 'u');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        return `hsl(${hue}, 85%, 55%)`;
    }

    function updatePresenceCursorMarker(u) {
        if (!squadMap || !presenceLayer || !u) return;
        // Don't show your own cursor
        if (mySocketId && u.id === mySocketId) {
            if (u.marker) {
                try {
                    presenceLayer.removeLayer(u.marker);
                } catch (_) {
                }
                u.marker = null;
            }
            return;
        }
        // Remove marker if no cursor
        if (!u.cursor || !Number.isFinite(u.cursor.lat) || !Number.isFinite(u.cursor.lng)) {
            if (u.marker) {
                try {
                    presenceLayer.removeLayer(u.marker);
                } catch (_) {
                }
                u.marker = null;
            }
            return;
        }
        const latlng = L.latLng(u.cursor.lat, u.cursor.lng);
        const col = colorForUser(u.id, u.name);
        if (!u.marker) {
            const m = L.circleMarker(latlng, {
                radius: 5,
                color: col,
                weight: 2,
                fillColor: col,
                fillOpacity: 0.7,
                opacity: 1
            });
            try {
                m.bindTooltip(() => `${u.name || shortId(u.id)}${u.tool ? ` · ${toolLabel(u.tool)}` : ''}`, {
                    permanent: true, direction: 'top', offset: [0, -10], className: 'squadmaps-presence-tip'
                });
            } catch (_) {
            }
            presenceLayer.addLayer(m);
            u.marker = m;
        } else {
            try {
                u.marker.setStyle({color: col, fillColor: col});
            } catch (_) {
            }
            try {
                u.marker.setTooltipContent(`${u.name || shortId(u.id)}${u.tool ? ` · ${toolLabel(u.tool)}` : ''}`);
            } catch (_) {
            }
            try {
                animateMarkerTo(u.marker, latlng, 120);
            } catch (_) {
                try {
                    u.marker.setLatLng(latlng);
                } catch (__) {
                }
            }
        }
    }

    function animateMarkerTo(marker, targetLatLng, durationMs) {
        try {
            if (!marker || !targetLatLng) return;
        } catch (_) {
            return;
        }
        const from = marker.getLatLng();
        const to = L.latLng(targetLatLng);
        const dur = Math.max(60, Number(durationMs) || 120);
        if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lng)) {
            try {
                marker.setLatLng(to);
            } catch (_) {
            }
            return;
        }
        const dLat = to.lat - from.lat;
        const dLng = to.lng - from.lng;
        if (Math.abs(dLat) + Math.abs(dLng) < 1e-10) return; // no movement
        if (marker.__animRaf) {
            cancelAnimationFrame(marker.__animRaf);
            marker.__animRaf = null;
        }
        const start = performance.now();

        function step(ts) {
            const t = Math.min(1, (ts - start) / dur);
            const lat = from.lat + dLat * t;
            const lng = from.lng + dLng * t;
            try {
                marker.setLatLng([lat, lng]);
            } catch (_) {
            }
            if (t < 1) {
                marker.__animRaf = requestAnimationFrame(step);
            } else {
                marker.__animRaf = null;
            }
        }

        marker.__animRaf = requestAnimationFrame(step);
    }

    // Helper: short ID for display (trims and masks)
    function shortId(id) {
        if (!id) return 'anon';
        const s = String(id);
        return s.length > 6 ? s.slice(0, 3) + '…' + s.slice(-2) : s;
    }

    function toolLabel(t) {
        if (!t) return '';
        const m = {
            polygon: 'Polygon',
            polyline: 'Polyline',
            rectangle: 'Rectangle',
            circle: 'Circle',
            marker: 'Marker',
            edit: 'Edit',
            delete: 'Delete'
        };
        return m[t] || t;
    }

    function buildPresenceUI() {
        // If already built, ensure it's parented to the current map container and positioned correctly
        if (presencePanelEl) {
            try {
                const parent = (squadMap && squadMap._container) || document.body;
                if (presencePanelEl.parentElement !== parent) parent.appendChild(presencePanelEl);
                presencePanelEl.style.position = (parent === document.body) ? 'fixed' : 'absolute';
                presencePanelEl.style.top = '';
                presencePanelEl.style.bottom = '8px';
                presencePanelEl.style.right = '8px';
                // Recalculate offset next to controls (to the left of them)
                try {
                    if (typeof updatePresencePanelPosition === 'function') updatePresencePanelPosition();
                } catch (_) {
                }
            } catch (_) {
            }
            return;
        }
        const wrap = document.createElement('div');
        wrap.id = 'squadmaps-presence-panel';
        // Decide parent: prefer the map container so the panel is visually attached to the map
        const parent = (squadMap && squadMap._container) || document.body;
        const inMap = (parent !== document.body);
        Object.assign(wrap.style, {
            position: inMap ? 'absolute' : 'fixed',
            // Anchor to bottom-right area by default; exact right offset adjusts after mount to sit left of controls
            right: '8px',
            bottom: '8px',
            zIndex: 10000, background: '#171718', color: '#fff',
            border: '1px solid #2a2a2b', borderRadius: '6px', boxShadow: '0 2px 8px rgba(0,0,0,0.4)', width: '220px',
            font: '12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
        });
        wrap.innerHTML = `
<div style="padding:8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #2a2a2b;">
  <span style="white-space:nowrap">Name</span>
  <input id="squadmaps-username" type="text" placeholder="Your name" style="flex:1; min-width:0; background:#0f0f10; color:#fff; border:1px solid #2a2a2b; border-radius:4px; padding:4px 6px;" maxlength="32"/>
</div>
<div id="squadmaps-userlist" style="max-height:180px; overflow:auto; padding:6px 8px;">
</div>`;
        parent.appendChild(wrap);
        presencePanelEl = wrap;

        // Helper to position panel to the left of bottom-right Leaflet controls
        function updatePresencePanelPosition() {
            try {
                if (!presencePanelEl) return;
                const mapContainer = squadMap && squadMap._container;
                // Always anchor to bottom of the map with an 8px gap
                presencePanelEl.style.bottom = '8px';
                if (mapContainer && presencePanelEl.parentElement === mapContainer) {
                    const br = mapContainer.querySelector('.leaflet-control-container .leaflet-bottom.leaflet-right');
                    let rightPad = 8;
                    if (br) {
                        const w = br.offsetWidth || 0;
                        rightPad = Math.max(8, Math.round(w) + 8); // leave an 8px gap to the left of controls
                    }
                    presencePanelEl.style.right = rightPad + 'px';
                } else {
                    presencePanelEl.style.right = '8px';
                }
            } catch (_) {
            }
        }

        // Expose locally so we can call it from early returns above
        try {
            window.updatePresencePanelPosition = updatePresencePanelPosition;
        } catch (_) {
        }

        // Observe size changes of the control stack and window/map resizes
        try {
            const mapContainer = squadMap && squadMap._container;
            if (mapContainer) {
                const br = mapContainer.querySelector('.leaflet-control-container .leaflet-bottom.leaflet-right');
                if (br && 'ResizeObserver' in window) {
                    const ro = new ResizeObserver(() => updatePresencePanelPosition());
                    ro.observe(br);
                    // Keep a ref to disconnect later if needed
                    presencePanelEl.__ro = ro;
                }
                try {
                    squadMap.on && squadMap.on('resize', updatePresencePanelPosition);
                } catch (_) {
                }
            }
            window.addEventListener('resize', updatePresencePanelPosition);
        } catch (_) {
        }

        const input = wrap.querySelector('#squadmaps-username');
        try {
            const saved = localStorage.getItem(USERNAME_KEY);
            if (saved) input.value = saved;
        } catch (_) {
        }
        // Load saved follow selection (if any)
        try {
            const savedFollow = localStorage.getItem(FOLLOW_KEY) || '';
            followingUserId = savedFollow || null;
        } catch (_) {
        }
        input.addEventListener('change', () => {
            const name = (input.value || '').trim().slice(0, 32);
            try {
                localStorage.setItem(USERNAME_KEY, name);
            } catch (_) {
            }
            socket.emit('username set', {name});
            // Also reflect locally for quicker UI update
            if (mySocketId && presenceUsers[mySocketId]) {
                presenceUsers[mySocketId].name = name || null;
                renderUserList();
            }
        });
        if (!document.getElementById('squadmaps-presence-css')) {
            const st = document.createElement('style');
            st.id = 'squadmaps-presence-css';
            st.textContent = `.squadmaps-presence-tip{background:#000c;border:none;color:#fff;}
#squadmaps-presence-panel .user{display:flex; align-items:center; gap:6px; padding:3px 0;}
#squadmaps-presence-panel .user .dot{width:8px;height:8px;border-radius:50%;}
#squadmaps-presence-panel .user .name{flex:1; min-width:0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;}
#squadmaps-presence-panel input[type=radio]{accent-color:#3b82f6;}`;
            document.head.appendChild(st);
        }
        renderUserList();
        // Initial position after content render
        try {
            updatePresencePanelPosition();
        } catch (_) {
        }
    }

    function renderUserList() {
        if (!presencePanelEl) return;
        const list = presencePanelEl.querySelector('#squadmaps-userlist');
        if (!list) return;
        const entries = Object.values(presenceUsers);
        entries.sort((a, b) => {
            const an = (a.name || '').toLowerCase();
            const bn = (b.name || '').toLowerCase();
            return (an || '') < (bn || '') ? -1 : (an || '') > (bn || '') ? 1 : (a.id < b.id ? -1 : 1);
        });
        const radioName = 'squadmaps-follow';
        const noneChecked = !followingUserId;
        let html = `<label class="user" title="Stop following">
  <input type="radio" name="${radioName}" value="" ${noneChecked ? 'checked' : ''} />
  <span class="dot" style="background:#555"></span>
  <span class="name">None</span>
</label>`;
        entries.forEach(u => {
            const isSelf = (u.id === mySocketId);
            const col = colorForUser(u.id, u.name);
            const checked = followingUserId === u.id ? 'checked' : '';
            const disabled = isSelf ? 'disabled' : '';
            html += `<label class="user" data-id="${u.id}">
  <input type="radio" name="${radioName}" value="${u.id}" ${checked} ${disabled} />
  <span class="dot" style="background:${col}"></span>
  <span class="name" title="${u.name || shortId(u.id)}">${(u.name || shortId(u.id)).replace(/[<>&]/g, c => ({
                '<': '&lt;',
                '>': '&gt;',
                '&': '&amp;'
            }[c]))}</span>
  <span class="tool" style="opacity:.8">${u.tool ? toolLabel(u.tool) : ''}</span>
</label>`;
        });
        list.innerHTML = html;
        list.querySelectorAll('input[type=radio]').forEach(inp => {
            inp.addEventListener('change', e => {
                const val = e.target.value || '';
                followingUserId = val || null;
                try {
                    localStorage.setItem(FOLLOW_KEY, followingUserId || '');
                } catch (_) {
                }
                if (followingUserId && presenceUsers[followingUserId]) {
                    const u = presenceUsers[followingUserId];
                    if (u.view) {
                        applyRemoteViewIfPossible(u.view);
                    }
                }
            });
        });
    }

    function upsertPresenceUser(u) {
        if (!u || !u.id) return;
        const prev = presenceUsers[u.id] || {id: u.id};
        const merged = Object.assign(prev, u);
        presenceUsers[u.id] = merged;
        // Update UI and cursor marker
        ensurePresenceLayer();
        updatePresenceCursorMarker(merged);
        renderUserList();
    }

    function removePresenceUser(id) {
        const u = presenceUsers[id];
        if (!u) return;
        if (u.marker) {
            try {
                presenceLayer.removeLayer(u.marker);
            } catch (_) {
            }
        }
        delete presenceUsers[id];
        if (followingUserId === id) {
            followingUserId = null;
            try {
                localStorage.setItem(FOLLOW_KEY, '');
            } catch (_) {
            }
        }
        renderUserList();
    }

    function attachPresenceEmitters() {
        if (presenceHandlersAttached || !squadMap) return;
        presenceHandlersAttached = true;
        // Cursor updates (throttled)
        let lastCursorEmit = 0;
        squadMap.on('mousemove', (e) => {
            const now = Date.now();
            if (now - lastCursorEmit < 90) return;
            lastCursorEmit = now;
            if (!e || !e.latlng) return;
            socket.emit('presence update', {cursor: {lat: e.latlng.lat, lng: e.latlng.lng}});
            // reflect locally to move self badge smoothly
            if (mySocketId) {
                upsertPresenceUser({id: mySocketId, cursor: {lat: e.latlng.lat, lng: e.latlng.lng}});
            }
        });
        // View updates on moveend
        squadMap.on('moveend', () => {
            try {
                const c = squadMap.getCenter();
                const z = squadMap.getZoom();
                socket.emit('presence update', {view: {center: {lat: c.lat, lng: c.lng}, zoom: z}});
                if (mySocketId) upsertPresenceUser({id: mySocketId, view: {center: {lat: c.lat, lng: c.lng}, zoom: z}});
            } catch (_) {
            }
        });
        // Tool state
        squadMap.on('draw:drawstart', (e) => {
            const t = e && e.layerType;
            socket.emit('presence update', {tool: t || null});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: t || null});
        });
        squadMap.on('draw:drawstop', () => {
            socket.emit('presence update', {tool: null});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: null});
        });
        squadMap.on('draw:editstart', () => {
            socket.emit('presence update', {tool: 'edit'});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: 'edit'});
        });
        squadMap.on('draw:editstop', () => {
            socket.emit('presence update', {tool: null});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: null});
        });
        squadMap.on('draw:deletestart', () => {
            socket.emit('presence update', {tool: 'delete'});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: 'delete'});
        });
        squadMap.on('draw:deletestop', () => {
            socket.emit('presence update', {tool: null});
            if (mySocketId) upsertPresenceUser({id: mySocketId, tool: null});
        });
    }

    // ---------------- Utilities ----------------
    function waitForLeaflet() {
        return !!(window.L && L.Map && L.CircleMarker);
    }

    function injectDrawAssetsOnce() {
        if (!document.getElementById('leaflet-draw-css')) {
            const link = document.createElement('link');
            link.id = 'leaflet-draw-css';
            link.rel = 'stylesheet';
            link.href = 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css';
            document.head.appendChild(link);
        }
        if (!window.L || window.L.Draw) {
            // If already loaded ensure patch applied once
            try {
                patchDrawFeatureHook();
            } catch (_) {
            }
            return Promise.resolve();
        }
        return new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js';
            s.onload = () => {
                console.log('[sync] Leaflet.draw loaded');
                try {
                    patchDrawFeatureHook();
                } catch (_) {
                }
                res();
            };
            s.onerror = (e) => {
                console.warn('[sync] Leaflet.draw load failed', e);
                rej(e);
            };
            document.head.appendChild(s);
        });
    }

    // --- Reliable handler capture & global right-click patch ---
    function patchDrawFeatureHook() {
        if (!window.L || !L.Draw || !L.Draw.Feature || L.Draw.Feature.__squadHooked) return;
        const featProto = L.Draw.Feature.prototype;
        const origEnable = featProto.enable;
        const origDisable = featProto.disable;
        featProto.enable = function () {
            const rv = origEnable.apply(this, arguments);
            try {
                window.__squadActiveDrawHandler = this;
                this.__squadStartMarkerCount = (this._markers ? this._markers.length : 0);
            } catch (_) {
            }
            if (window.__squadDrawVerbose) console.log('[rc-hook] enable type=', this.type);
            return rv;
        };
        featProto.disable = function () {
            const was = (window.__squadActiveDrawHandler === this);
            const rv = origDisable.apply(this, arguments);
            if (was) window.__squadActiveDrawHandler = null;
            if (window.__squadDrawVerbose) console.log('[rc-hook] disable type=', this.type);
            return rv;
        };
        L.Draw.Feature.__squadHooked = true;

        // Helper used by all right-click interception paths
        function __squadHandleRCFinish(handler, domEv) {
            if (!handler) return false;
            const t = handler.type || '';
            if (!/polyline|polygon|rectangle|circle|marker/.test(t)) return false;
            // Always suppress native menu while a draw tool is active
            try {
                domEv.preventDefault();
                domEv.stopPropagation();
            } catch (_) {
            }
            if (window.__squadDrawVerbose) console.log('[rc-hook] contextmenu type=', t, 'markers=', handler._markers && handler._markers.length);
            // Manual fallback
            if (customDraw && (customDraw.type === 'polyline' || customDraw.type === 'polygon')) {
                manualFinish();
                return true;
            }
            const isPoly = /polyline|polygon/.test(t);
            const isRect = /rectangle/.test(t);
            const isCirc = /circle/.test(t) && !/circlemarker/.test(t);
            const isMarker = /marker/.test(t) && !/circlemarker/.test(t);
            const mapRef = handler._map || window.squadMap;
            let rcLatLng = null;
            try {
                if (mapRef && domEv && typeof mapRef.mouseEventToLatLng === 'function') rcLatLng = mapRef.mouseEventToLatLng(domEv);
            } catch (_) {
            }
            if (isMarker) {
                // Treat right-click as cancel/end of marker tool (esp. in continuous mode)
                try {
                    handler.disable && handler.disable();
                } catch (_) {
                }
                continuousActiveType = null;
                return true;
            }
            if (isPoly) {
                const pts = Array.isArray(handler._markers) ? handler._markers.length : 0;
                const need = /polygon/.test(t) ? 3 : 2;
                // Cancel (continuous) with zero user points
                if (pts === 0 && continuousModeEnabled) {
                    try {
                        handler.disable && handler.disable();
                    } catch (_) {
                    }
                    continuousActiveType = null;
                    return true;
                }
                if (pts >= need) {
                    // Capture existing latlngs BEFORE finish
                    let beforeLatLngs = [];
                    try {
                        if (handler._poly) {
                            const raw = handler._poly.getLatLngs();
                            // Flatten 1-level for polygon (first ring) else polyline straight
                            if (/polygon/.test(t) && Array.isArray(raw) && raw.length > 0) beforeLatLngs = raw[0].slice(); else if (Array.isArray(raw)) beforeLatLngs = raw.slice();
                        }
                    } catch (_) {
                    }
                    try {
                        if (typeof handler._finishShape === 'function') handler._finishShape();
                        else if (typeof handler.completeShape === 'function') handler.completeShape();
                        else if (typeof handler._completeShape === 'function') handler._completeShape();
                        else if (typeof handler._endShape === 'function') handler._endShape();
                        else handler.disable && handler.disable();
                    } catch (err) {
                        console.warn('[sync] rc finish error', err);
                    }
                    // After finishing, prune spurious last point if it matches right-click (avoid adding extra vertex at RC position)
                    if (rcLatLng && handler._poly) {
                        try {
                            const after = handler._poly.getLatLngs();
                            let arr = after;
                            let polyMode = false;
                            if (/polygon/.test(t)) {
                                polyMode = true;
                                if (Array.isArray(after) && after.length > 0) arr = after[0];
                            }
                            if (Array.isArray(arr) && arr.length > 0) {
                                // If length increased by 1 and last point close to rc position AND not equal to last before finish -> remove it
                                if (arr.length === beforeLatLngs.length + 1) {
                                    const last = arr[arr.length - 1];
                                    const prevLast = beforeLatLngs[beforeLatLngs.length - 1];
                                    const dRC = Math.abs(last.lat - rcLatLng.lat) + Math.abs(last.lng - rcLatLng.lng);
                                    const samePrev = prevLast && (Math.abs(last.lat - prevLast.lat) + Math.abs(last.lng - prevLast.lng) < 1e-12);
                                    if (dRC < 1e-7 && !samePrev) {
                                        arr.pop();
                                        if (polyMode) handler._poly.setLatLngs([arr]); else handler._poly.setLatLngs(arr);
                                        try {
                                            handler._poly.redraw && handler._poly.redraw();
                                        } catch (_) {
                                        }
                                    }
                                }
                            }
                        } catch (_) {
                        }
                    }
                }
                return true;
            }
            if (isRect || isCirc) {
                if (continuousModeEnabled) {
                    try {
                        handler.disable && handler.disable();
                    } catch (_) {
                    }
                    continuousActiveType = null;
                }
                return true; // just suppress menu
            }
            return false;
        }

        window.__squadHandleRCFinish = __squadHandleRCFinish; // expose for reuse

        // Global single contextmenu handler (capture) using active handler ref
        window.addEventListener('contextmenu', function (ev) {
            const h = window.__squadActiveDrawHandler;
            if (!h) return; // no active tool
            // Relaxed map containment check: allow by DOM containment OR pointer coords inside map bounds
            if (!window.squadMap || !squadMap._container) return;
            let inside = false;
            try {
                inside = squadMap._container.contains(ev.target);
                if (!inside && ev.clientX != null) {
                    const r = squadMap._container.getBoundingClientRect();
                    inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
                }
            } catch (_) {
            }
            if (!inside) return;
            __squadHandleRCFinish(h, ev);
        }, true);

        // NEW: Early pointer/mouse right-click interception to prevent Leaflet.Draw from adding an unwanted final vertex
        if (!window.__squadEarlyRCInstalled) {
            function earlyRC(ev) {
                try {
                    if (ev.button !== 2) return; // only right
                    const h = (squadMap && squadMap._toolbars && squadMap._toolbars.draw && squadMap._toolbars.draw._activeMode && squadMap._toolbars.draw._activeMode.handler) || window.__squadActiveDrawHandler;
                    if (!h) return;
                    const t = h.type || '';
                    if (!/polyline|polygon|rectangle|circle|marker/.test(t)) return;
                    // Determine if event within map (coords or containment)
                    if (!squadMap || !squadMap._container) return;
                    let inside = false;
                    if (squadMap._container.contains(ev.target)) inside = true; else if (ev.clientX != null) {
                        const r = squadMap._container.getBoundingClientRect();
                        inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
                    }
                    if (!inside) return;
                    // Prevent default BEFORE Leaflet handlers see it
                    ev.preventDefault();
                    ev.stopPropagation();
                    // Cancel vs finish logic
                    const isPoly = /polyline|polygon/.test(t);
                    const isRect = /rectangle/.test(t);
                    const isCirc = /circle/.test(t) && !/circlemarker/.test(t);
                    const isMarker = /marker/.test(t) && !/circlemarker/.test(t);
                    if (isMarker) {
                        try {
                            h.disable && h.disable();
                        } catch (_) {
                        }
                        continuousActiveType = null;
                        return;
                    }
                    if (isPoly) {
                        const pts = Array.isArray(h._markers) ? h._markers.length : 0;
                        const need = /polygon/.test(t) ? 3 : 2;
                        if (pts === 0) { // cancel empty tool (esp. continuous mode)
                            try {
                                h.disable && h.disable();
                            } catch (_) {
                            }
                            continuousActiveType = null;
                            return;
                        }
                        if (pts >= need) {
                            try {
                                if (typeof h._finishShape === 'function') h._finishShape();
                                else if (typeof h.completeShape === 'function') h.completeShape();
                                else if (typeof h._completeShape === 'function') h._completeShape();
                                else if (typeof h._endShape === 'function') h._endShape();
                                else h.disable && h.disable();
                            } catch (err) {
                                console.warn('[sync] earlyRC finish error', err);
                            }
                            return;
                        }
                        // If less than needed but not zero just cancel (acts like ESC)
                        try {
                            h.disable && h.disable();
                        } catch (_) {
                        }
                        continuousActiveType = null;
                        return;
                    } else if (isRect || isCirc) {
                        // For shapes drawn via drag, just suppress context menu; treat right-click as cancel if not yet committed
                        // If handler has no _shape (not started), cancel; else let regular mouseup finish logic proceed.
                        try {
                            if (!h._shape) {
                                h.disable && h.disable();
                                continuousActiveType = null;
                            }
                        } catch (_) {
                        }
                        return;
                    }
                } catch (err) {
                    console.warn('[sync] earlyRC error', err);
                }
            }

            window.addEventListener('pointerdown', earlyRC, true);
            window.addEventListener('mousedown', earlyRC, true);
            window.__squadEarlyRCInstalled = true;
        }
    }

    function hookClickableMarker(marker) {
        if (marker?._events?.click) {
            const origin = marker._events.click[0].fn;
            if (marker._events.alreadyHooked) return;
            marker._events.alreadyHooked = true;
            marker._events.click[0].fn = function (a) {
                if (!this) return origin();
                if (a && a[0] === 'r') return origin();
                origin();
                socket.emit('point clicked', this._latlng);
            };
            console.log('[sync] Hooked marker click', marker._latlng);
        }
    }

    function layerToSerializable(layer) {
        let geo = layer.toGeoJSON();
        if (!geo.properties) geo.properties = {};
        const baseColor = (layer.options && (layer.options.color || layer.options.fillColor)) || userColor || '#ff6600';
        if (layer instanceof L.Circle) {
            const center = layer.getLatLng();
            geo = {
                type: 'Feature',
                geometry: {type: 'Point', coordinates: [center.lng, center.lat]},
                properties: {radius: layer.getRadius(), shapeType: 'circle', color: baseColor}
            };
        } else if (layer instanceof L.Rectangle) {
            geo.properties.shapeType = 'rectangle';
            geo.properties.color = baseColor;
        } else if (layer instanceof L.Polygon && !(layer instanceof L.Rectangle)) {
            geo.properties.shapeType = 'polygon';
            geo.properties.color = baseColor;
        } else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            geo.properties.shapeType = 'polyline';
            geo.properties.color = baseColor;
        } else if (layer instanceof L.Marker) {
            geo.properties.shapeType = 'marker';
            geo.properties.color = baseColor;
            geo.properties.icon = (layer.__faIconName || currentMarkerIcon || DEFAULT_MARKER_ICON);
        }
        return geo;
    }

    function geojsonToLayer(feature) {
        const shapeType = feature?.properties?.shapeType;
        const color = feature?.properties?.color;
        try {
            if (shapeType === 'circle') {
                const c = feature.geometry?.coordinates;
                if (!c) return null;
                return L.circle([c[1], c[0]], {
                    radius: feature.properties.radius || 10,
                    color: color || '#ff6600',
                    fillColor: color || '#ff6600',
                    fillOpacity: 0.50,
                    opacity: 1
                });
            }
            if (shapeType === 'marker') {
                const c = feature.geometry?.coordinates;
                if (!c) return null;
                const iconName = feature?.properties?.icon || DEFAULT_MARKER_ICON;
                const icon = buildFaDivIcon(iconName, color || userColor);
                const m = L.marker([c[1], c[0]], {icon});
                m.__faIconName = iconName;
                m.__faColor = color || userColor;
                return m;
            }
            let created;
            L.geoJSON(feature, {pointToLayer: (f, ll) => L.marker(ll)}).eachLayer(l => created = l);
            if (created && color && created.setStyle) created.setStyle({color, fillColor: color, opacity: 1});
            return created;
        } catch (e) {
            console.warn('[sync] Failed geojson->layer', e, feature);
            return null;
        }
    }

    function generateId() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function injectToolbarOffsetCss() {
        if (document.getElementById('draw-toolbar-offset-css')) return;
        const style = document.createElement('style');
        style.id = 'draw-toolbar-offset-css';
        style.textContent = `.leaflet-top.leaflet-left .leaflet-draw-toolbar.leaflet-bar { margin-top: ${DRAW_TOOLBAR_OFFSET_PX}px !important; }`;
        document.head.appendChild(style);
        console.log('[sync] Applied draw toolbar offset', DRAW_TOOLBAR_OFFSET_PX);
    }

    function isDrawingActive() {
        return !!(squadMap?._toolbars?.draw?._activeMode);
    }

    function ensureClickProxy() {
        if (clickProxyDiv || !squadMap || !squadMap._container) return;
        clickProxyDiv = document.createElement('div');
        clickProxyDiv.id = 'squadmaps-draw-click-proxy';
        Object.assign(clickProxyDiv.style, {
            position: 'absolute',
            inset: '0',
            zIndex: 499,
            pointerEvents: 'none',
            background: 'transparent'
        });
        squadMap._container.style.position = 'relative';
        squadMap._container.appendChild(clickProxyDiv);
        console.log('[sync] Click proxy overlay created');
        const forward = (type, e) => {
            if (!isDrawingActive()) return;
            const latlng = squadMap.mouseEventToLatLng(e);
            if (!latlng) return;
            squadMap.fire(type, {
                latlng,
                layerPoint: squadMap.latLngToLayerPoint(latlng),
                containerPoint: squadMap.latLngToContainerPoint(latlng),
                originalEvent: e
            });
        };
        clickProxyDiv.addEventListener('click', e => {
            e.preventDefault();
            forward('click', e);
        }, true);
        clickProxyDiv.addEventListener('mousedown', e => {
            e.preventDefault();
            forward('mousedown', e);
        }, true);
        clickProxyDiv.addEventListener('mouseup', e => {
            e.preventDefault();
            forward('mouseup', e);
        }, true);
        clickProxyDiv.addEventListener('mousemove', e => {
            forward('mousemove', e);
        }, true);
        clickProxyDiv.addEventListener('contextmenu', e => {
            forward('contextmenu', e);
        }, true);
    }

    function setClickProxyActive(active) {
        ensureClickProxy();
        if (!clickProxyDiv) return;
        const activeType = squadMap?._toolbars?.draw?._activeMode?.handler?.type || '';
        // Do NOT use proxy for polyline/polygon so native handlers get original events
        if (/polyline|polygon/.test(activeType)) active = false;
        clickProxyDiv.style.pointerEvents = active ? 'auto' : 'none';
        dlog('Proxy', active ? 'enabled' : 'disabled', 'type=', activeType);
    }

    function forceEnableDrawHandler(toolClassName) {
        if (!drawControlRef || !squadMap || !window.L) return;
        const opts = drawControlRef.options?.draw || {};
        let handler;
        if (/draw-polyline/.test(toolClassName) && L.Draw.Polyline) handler = new L.Draw.Polyline(squadMap, opts.polyline || {});
        else if (/draw-polygon/.test(toolClassName) && L.Draw.Polygon) handler = new L.Draw.Polygon(squadMap, opts.polygon || {});
        else if (/draw-rectangle/.test(toolClassName) && L.Draw.Rectangle) handler = new L.Draw.Rectangle(squadMap, opts.rectangle || {});
        else if (/draw-circle/.test(toolClassName) && L.Draw.Circle) handler = new L.Draw.Circle(squadMap, opts.circle || {});
        else if (/draw-marker/.test(toolClassName) && L.Draw.Marker) handler = new L.Draw.Marker(squadMap, opts.marker || {});
        if (handler) {
            console.log('[sync] Forcing enable for', toolClassName);
            handler.enable();
        }
    }

    // Global draw created handler
    function onDrawCreated(e) {
        const layer = e.layer;
        if (!layer || !drawnItems) return;
        // Ensure interactivity for circles (Canvas renderer) so click events bubble
        try {
            if (layer instanceof L.Circle) {
                layer.options.interactive = true;
                if (layer._path) layer._path.style.pointerEvents = 'auto';
            }
        } catch (_) {
        }
        drawnItems.addLayer(layer);
        ensureLayerEditable(layer); // NEW make editable immediately (local native create)
        if (removeModeActive) attachRemoveHandler(layer);
        // NEW: apply FA icon to markers
        applyMarkerIconToLayerIfNeeded(layer);
        const geojson = layerToSerializable(layer);
        const geoStr = JSON.stringify(geojson);
        if (geoStr === lastCreatedGeoJSONString) {
            dlog('Skipping duplicate created (same geo)');
            return;
        }
        lastCreatedGeoJSONString = geoStr;
        const id = generateId();
        layer._drawSyncId = id;
        layerIdMap[id] = layer;
        console.log('[sync] draw create emit', id);
        socket.emit('draw create', {id, geojson});
        // After creation: show radial selector for markers
        try {
            if (layer instanceof L.Marker) {
                // Mark radial as open immediately so draw:drawstop can defer continuous reactivation
                window.__squadMarkerRadialOpen = true;
                setTimeout(() => showMarkerRadialMenu(layer), 0);
            }
        } catch (_) {
        }
        // Mark creation occurred for this session; re-enable deferred in draw:drawstop only
        currentDrawCreationOccurred = true;
        // Removed immediate re-enable here to avoid racing with plugin teardown
    }

    function reenableContinuousTool(layerType) {
        if (!layerType) return;
        if (!/polygon|polyline|rectangle|circle|marker/.test(layerType)) return;
        let attempts = 0;
        const maxAttempts = 14; // extend to ~1.4s worst case (14 * 100ms)
        function tryEnable() {
            attempts++;
            if (!continuousModeEnabled) {
                dlog('Continuous abort: disabled mid-way');
                return;
            }
            if (continuousActiveType !== layerType) {
                dlog('Continuous abort: active type changed', continuousActiveType, '!=', layerType);
                return;
            }
            const tb = squadMap?._toolbars?.draw;
            const active = tb?._activeMode;
            const modes = tb?._modes;
            if (!modes) {
                if (attempts < maxAttempts) return setTimeout(tryEnable, 100);
                return;
            }
            if (active && active.handler && active.handler.type === layerType) {
                dlog('Continuous: already active after', attempts, 'attempts');
                return;
            }
            let targetMode = null;
            for (const m of Object.values(modes)) {
                if (m?.handler?.type === layerType) {
                    targetMode = m;
                    break;
                }
            }
            if (!targetMode) {
                dlog('Continuous: mode not found attempt', attempts);
                if (attempts < maxAttempts) return setTimeout(tryEnable, 100);
                return;
            }
            try {
                dlog('Continuous re-enable attempt', attempts, 'type=', layerType);
                // First try direct enable
                targetMode.handler.enable();
                // If still not active, fallback to simulating toolbar button click
                setTimeout(() => {
                    const still = tb?._activeMode;
                    if (!(still && still.handler && still.handler.type === layerType) && targetMode.button) {
                        try {
                            dlog('Continuous fallback click button');
                            targetMode.button.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
                        } catch (_) {
                        }
                    }
                }, 30);
            } catch (err) {
                console.warn('[sync] continuous enable error', err);
            }
            if (attempts < maxAttempts) {
                setTimeout(tryEnable, 100);
            }
        }

        setTimeout(tryEnable, 60);
    }

    function scheduleContinuous(layerType, attempt, expectedSession) {
        attempt = attempt || 0;
        expectedSession = (expectedSession === undefined ? currentDrawSessionId : expectedSession);
        if (!continuousModeEnabled) return;
        if (!layerType) return;
        if (expectedSession !== currentDrawSessionId) return; // aborted due to new session
        if (attempt > 8) return; // fewer retries now that we delay initial call sufficiently
        const active = squadMap?._toolbars?.draw?._activeMode;
        if (active && active.handler && active.handler.type === layerType) return; // already active
        // Abort if user manually clicked another tool very recently (within 250ms after drawstop)
        if (Date.now() - lastToolbarClickAt < 250) return;
        const btnSel = '.leaflet-draw-draw-' + layerType;
        const btn = document.querySelector(btnSel);
        if (!btn) {
            return void setTimeout(() => scheduleContinuous(layerType, attempt + 1, expectedSession), 120);
        }
        try {
            btn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
            btn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
            btn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        } catch (_) {
        }
        setTimeout(() => {
            if (expectedSession !== currentDrawSessionId) return; // aborted
            const act2 = squadMap?._toolbars?.draw?._activeMode;
            if (!(act2 && act2.handler && act2.handler.type === layerType)) scheduleContinuous(layerType, attempt + 1, expectedSession);
        }, 140);
    }

    // ---- RESTORED / CORE FUNCTIONS (previously removed) ----
    function emitMapChangedIfNeeded(reason) {
        const path = window.location.pathname + window.location.search;
        if (suppressNextMapEmit || !path.includes("?")) {
            console.log('[sync] Suppressed map emit', reason);
            suppressNextMapEmit = false;
            return;
        }
        if (!serverCurrentMap || path !== serverCurrentMap || path !== lastEmittedMap) {
            lastEmittedMap = path;
            serverCurrentMap = path;
            console.log('[sync] Emitting map changed', reason, path);
            socket.emit('map changed', path);
        }
    }

    function hookExistingMarkers() {
        if (!squadMap) return;
        Object.values(squadMap._layers || {}).forEach(l => {
            if (l instanceof L.CircleMarker) hookClickableMarker(l);
        });
    }

    function tryFindAndClick(latlng, attemptsLeft, resolve) {
        if (!squadMap) {
            if (attemptsLeft <= 0) return resolve();
            return setTimeout(() => tryFindAndClick(latlng, attemptsLeft - 1, resolve), 120);
        }
        for (const k of Object.keys(squadMap._layers)) {
            const layer = squadMap._layers[k];
            if (layer?._latlng?.equals && layer._latlng.equals(latlng) && layer?._events?.click) {
                layer.fire('click', 'r');
                return resolve();
            }
        }
        if (attemptsLeft <= 0) return resolve();
        setTimeout(() => tryFindAndClick(latlng, attemptsLeft - 1, resolve), 120);
    }

    async function replayClicksSequential(clicks) {
        for (const latlng of clicks) {
            await new Promise(res => tryFindAndClick(latlng, 10, res));
            await new Promise(r => setTimeout(r, 120));
        }
    }

    // Modify setupDrawingTools to patch & add quick-stop detection
    function setupDrawingTools() {
        if (!window.L || !squadMap) return;
        // Ensure Leaflet.Draw is loaded before proceeding (parity with old bootstrap sequencing)
        if (!L.Control || !L.Control.Draw || !L.Draw) {
            try {
                injectDrawAssetsOnce();
            } catch (_) {
            }
            return void setTimeout(setupDrawingTools, 200);
        }
        if (drawnItems && drawnItems._map && drawnItems._map !== squadMap) {
            try {
                drawnItems = null;
                drawControlRef = null;
            } catch (_) {
            }
        }
        const toolbarPresent = !!document.querySelector('.leaflet-draw-toolbar.leaflet-bar');
        if (drawControlRef && drawnItems && toolbarPresent) return;
        // Remove lingering old control before creating new one
        try {
            if (drawControlRef && squadMap && drawControlRef._map === squadMap) {
                squadMap.removeControl(drawControlRef);
            }
        } catch (_) {
        }
        drawnItems = new L.FeatureGroup();
        squadMap.addLayer(drawnItems);
        // NEW: separate container for in-progress overlays
        progressItems = new L.FeatureGroup();
        squadMap.addLayer(progressItems);
        try {
            progressItems.bringToFront && progressItems.bringToFront();
        } catch (_) {
        }
        const drawControl = new L.Control.Draw({
            draw: {
                polygon: {
                    shapeOptions: {
                        color: userColor,
                        fillColor: userColor,
                        fillOpacity: 0.50,
                        opacity: 1,
                        interactive: true
                    }
                },
                polyline: {shapeOptions: {color: userColor, weight: 3, opacity: 1, interactive: true}},
                rectangle: {
                    shapeOptions: {
                        color: userColor,
                        fillColor: userColor,
                        fillOpacity: 0.50,
                        opacity: 1,
                        interactive: true
                    }
                },
                circle: {
                    shapeOptions: {
                        color: userColor,
                        fillColor: userColor,
                        fillOpacity: 0.50,
                        opacity: 1,
                        interactive: true
                    }
                },
                marker: {icon: buildFaDivIcon(currentMarkerIcon, userColor)},
                circlemarker: false
            },
            edit: {featureGroup: drawnItems, remove: true}
        });
        squadMap.addControl(drawControl);
        drawControlRef = drawControl;
        // Remove any previously injected manual poly buttons if present
        document.querySelectorAll('.leaflet-draw-manual-polyline, .leaflet-draw-manual-polygon').forEach(el => el.remove());
        injectToolbarOffsetCss();
        console.log('[sync] Drawing tools initialized (native polyline/polygon enabled)');
        // Keep only needed events for tools
        squadMap.on('draw:drawstart', e => {
            if (squadMap.dragging.enabled()) squadMap.dragging.disable();
            continuousActiveType = e.layerType; // track active tool for continuous mode
            lastDrawButtonSelector = '.leaflet-draw-draw-' + e.layerType;
            currentDrawCreationOccurred = false; // reset for new session
            currentDrawSessionId++; // start new session id
            setClickProxyActive(!/polyline|polygon/.test(e.layerType));
            disablePointerBlockers();
            dlog('drawstart', e.layerType);
            // NEW: robust right-click state
            drawToolEngaged = true;
            activeDrawLayerType = e.layerType;
            setTimeout(() => { // allow Leaflet to set _activeMode
                try {
                    activeDrawHandler = squadMap?._toolbars?.draw?._activeMode?.handler || activeDrawHandler;
                } catch (_) {
                }
                if (window.__squadDrawVerbose) console.log('[rc-debug] handler captured type=', activeDrawHandler && activeDrawHandler.type);
                // NEW: begin live progress for polyline/polygon
                __startProgressTrackingIfNeeded(e.layerType);
            }, 0);
            suppressContextMenuActive = true;
            try {
                squadMap._container.setAttribute('data-squad-nocontext', '1');
                squadMap._container.oncontextmenu = () => false;
            } catch (_) {
            }
        });
        // NEW: Emit an immediate progress update whenever a new vertex is added while drawing
        squadMap.on('draw:drawvertex', () => {
            try {
                if (!currentProgressType) return;
                const sample = __collectActiveHandlerPoints(activeDrawHandler, currentProgressType);
                if (!sample) return;
                let payload;
                if (currentProgressType === 'circle' && sample.center && typeof sample.radius === 'number') {
                    payload = { id: currentProgressId || ('p_'+generateId()), shapeType: currentProgressType, center: sample.center, radius: sample.radius };
                } else {
                    const pts = Array.isArray(sample) ? sample : [];
                    if (!pts.length) return;
                    payload = { id: currentProgressId || ('p_'+generateId()), shapeType: currentProgressType, points: pts };
                }
                socket.emit('draw progress', payload);
            } catch (_) {}
        });
        squadMap.on('draw:drawstop', () => {
            if (!squadMap.dragging.enabled()) squadMap.dragging.enable();
            setClickProxyActive(false);
            restorePointerBlockers();
            dlog('drawstop');
            // NEW: clear rc state (delayed slightly in case finish logic runs post-stop)
            setTimeout(() => {
                drawToolEngaged = false;
                activeDrawHandler = null;
                activeDrawLayerType = null;
            }, 50);
            suppressContextMenuActive = false;
            try {
                squadMap._container.removeAttribute('data-squad-nocontext');
                squadMap._container.oncontextmenu = null;
            } catch (_) {
            }
            // NEW: end any active live progress
            __stopProgressTransmission(true);
            // Only re-enable if a shape was actually created & user hasn't manually switched tools
            const sessionIdAtStop = currentDrawSessionId;
            if (continuousModeEnabled && continuousActiveType && currentDrawCreationOccurred) {
                const typeToReenable = continuousActiveType;
                // If a marker was placed and the radial menu is open, defer until it closes
                if (typeToReenable === 'marker' && window.__squadMarkerRadialOpen) {
                    onMarkerRadialClosedOnce(() => {
                        if (sessionIdAtStop === currentDrawSessionId) scheduleContinuous(typeToReenable, 0, sessionIdAtStop);
                    });
                } else {
                    setTimeout(() => {
                        if (sessionIdAtStop === currentDrawSessionId) scheduleContinuous(typeToReenable, 0, sessionIdAtStop);
                    }, 180);
                }
            }
        });
        // NEW: handle edit mode drag suppression
        let __preEditDbl = true;
        squadMap.on('draw:editstart', () => {
            const removeMode = !!document.querySelector('.leaflet-draw-edit-remove.leaflet-draw-edit-remove-active');
            dlog('editstart', 'removeMode=', removeMode);
            if (customDraw) manualCancel('enter-edit');
            if (squadMap.dragging.enabled()) squadMap.dragging.disable();
            if (squadMap.doubleClickZoom?.enabled && squadMap.doubleClickZoom.enabled()) {
                __preEditDbl = true;
                try {
                    squadMap.doubleClickZoom.disable();
                } catch (_) {
                }
            } else __preEditDbl = false;
            // In remove mode we must NOT enable per-layer editing, otherwise click removal is blocked by edit vertex handlers
            if (removeMode) {
                disableAllLayerEditing();
            } else {
                forceEnableAllLayerEditing();
            }
            disablePointerBlockers();
        });
        squadMap.on('draw:editstop', () => {
            dlog('editstop');
            if (!squadMap.dragging.enabled()) try {
                squadMap.dragging.enable();
            } catch (_) {
            }
            if (__preEditDbl && squadMap.doubleClickZoom?.disable) {
                try {
                    squadMap.doubleClickZoom.enable();
                } catch (_) {
                }
            }
            disableAllLayerEditing();
            restorePointerBlockers();
        });
        // NEW: handle delete mode separately + fallback manual deletion
        squadMap.on('draw:deletestart', () => {
            removeModeActive = true;
            dlog('deletestart (plugin)');
            applyRemoveModeStyling(true);
            refreshRemoveHandlers();
        });
        squadMap.on('draw:deletestop', () => {
            removeModeActive = false;
            dlog('deletestop (plugin)');
            applyRemoveModeStyling(false);
            refreshRemoveHandlers();
        });
        squadMap.on('click', e => {
            if (!removeModeActive) return; // rely on built-in first; fallback only
            let targetLayer = null;
            const ll = e.latlng;
            const lp = e.layerPoint || (ll ? squadMap.latLngToLayerPoint(ll) : null);
            drawnItems && drawnItems.eachLayer(l => {
                if (!targetLayer && layerRoughHit(l, ll, lp)) targetLayer = l;
            });
            if (targetLayer && !targetLayer._removed) {
                const id = targetLayer._drawSyncId;
                drawnItems.removeLayer(targetLayer);
                if (id) {
                    delete layerIdMap[id];
                    socket.emit('draw delete', [id]);
                    dlog('fallback delete emitted', id);
                }
            }
        });
        if (drawCreatedHandlerAttached) {
            squadMap.off('draw:created', onDrawCreated);
            drawCreatedHandlerAttached = false;
        }
        squadMap.on('draw:created', onDrawCreated);
        drawCreatedHandlerAttached = true;
        buildColorPickerUI();

        // New: emit edits
        squadMap.on('draw:edited', ev => {
            if (!ev?.layers) return;
            const edited = [];
            ev.layers.eachLayer(layer => {
                if (!layer._drawSyncId) return;
                const geojson = layerToSerializable(layer);
                edited.push({id: layer._drawSyncId, geojson});
            });
            if (edited.length) {
                console.log('[sync] draw edit emit', edited.length);
                socket.emit('draw edit', edited);
            }
        });
        // New: emit deletes
        squadMap.on('draw:deleted', ev => {
            if (!ev?.layers) return;
            const ids = [];
            ev.layers.eachLayer(layer => {
                if (layer._drawSyncId) ids.push(layer._drawSyncId);
            });
            if (ids.length) {
                console.log('[sync] draw delete emit', ids.length);
                socket.emit('draw delete', ids);
                ids.forEach(id => delete layerIdMap[id]);
            }
        });
        attachMapDomDebug();
        // Add right-click finish support (only once) for native polyline/polygon
        if (!squadMap.__rightClickFinishAttached) {
            function __handleActiveToolRightClick(domEv) {
                const handler = squadMap?._toolbars?.draw?._activeMode?.handler || window.__squadActiveDrawHandler;
                if (!handler) return false;
                if (typeof window.__squadHandleRCFinish === 'function') return !!window.__squadHandleRCFinish(handler, domEv);
                return false;
            }

            // Original container listeners (still useful if they fire)
            try {
                squadMap._container.addEventListener('mousedown', ev => {
                    if (ev.button === 2 && __handleActiveToolRightClick(ev)) {
                    }
                }, true);
            } catch (_) {
            }
            try {
                squadMap._container.addEventListener('mouseup', ev => {
                    if (ev.button === 2 && __handleActiveToolRightClick(ev)) {
                    }
                }, true);
            } catch (_) {
            }
            squadMap.on('contextmenu', e => {
                if (e.originalEvent) __handleActiveToolRightClick(e.originalEvent);
            });
            try {
                squadMap._container.addEventListener('contextmenu', ev => {
                    __handleActiveToolRightClick(ev);
                }, true);
            } catch (_) {
            }
            // Global capture listeners (some site overlays swallow container events or user right-click starts outside canvas)
            if (!window.__squadGlobalRCInstalled) {
                window.addEventListener('contextmenu', ev => {
                    if (!squadMap || !squadMap._container) return;
                    if (!squadMap._container.contains(ev.target)) return; // outside map
                    __handleActiveToolRightClick(ev);
                }, true);
                window.addEventListener('pointerdown', ev => { // pre-empt default menu on some browsers
                    if (ev.button !== 2) return;
                    if (!squadMap || !squadMap._container) return;
                    if (!squadMap._container.contains(ev.target)) return;
                    __handleActiveToolRightClick(ev);
                }, true);
                window.__squadGlobalRCInstalled = true;
            }
            squadMap.__rightClickFinishAttached = true;
        }
    }

    function addInitHooks() {
        if (!window.L) return;
        L.Map.addInitHook(function () {
            // Detect new map instance & reset draw state so tools are rebuilt
            if (window.squadMap && window.squadMap !== this) {
                try {
                    drawnItems = null;
                    drawControlRef = null;
                } catch (_) {
                }
            }
            window.__squadToolbarRecoveryReady = false;
            squadMap = this;
            currentMap = window.location.pathname + window.location.search;
            suppressContextMenuActive = false;
            setTimeout(() => {
                emitMapChangedIfNeeded('leaflet-init');
                setupDrawingTools();
                hookExistingMarkers();
                ensureClickProxy();
                attachMapDomDebug();
                buildColorPickerUI();
                attachViewSyncHandlers(); // ensure Sync View button exists
                // Presence init on map ready
                try {
                    ensurePresenceLayer();
                    buildPresenceUI();
                    attachPresenceEmitters();
                } catch (_) {
                }
                // Apply pending initial view from server if available
                if (pendingInitialView) {
                    applyRemoteViewIfPossible(pendingInitialView);
                    pendingInitialView = null;
                }
            }, 300);
        });
        L.CircleMarker.addInitHook(function () {
            const m = this;
            setTimeout(() => hookClickableMarker(m), 100);
        });
    }

    function onMapHooked(map, reason) {
        if (!map || map.__squadHookProcessed) return;
        map.__squadHookProcessed = true;
        window.squadMap = map;
        try {
            currentMap = window.location.pathname + window.location.search;
        } catch (_) {
        }
        if (window.__squadDrawVerbose) console.log('[hook] map captured via', reason);
        // Delay slightly to allow Leaflet internals to finish
        setTimeout(() => {
            try {
                setupDrawingTools();
            } catch (_) {
            }
            try {
                hookExistingMarkers();
            } catch (_) {
            }
            try {
                ensureClickProxy();
            } catch (_) {
            }
            try {
                buildColorPickerUI();
            } catch (_) {
            }
            try {
                attachViewSyncHandlers(); // ensure Sync View button exists
            } catch (_) {
            }
            // Presence init when hooking late
            try {
                ensurePresenceLayer();
                buildPresenceUI();
                attachPresenceEmitters();
            } catch (_) {
            }
            if (pendingInitialView) { // apply if we joined mid-session
                applyRemoteViewIfPossible(pendingInitialView);
                pendingInitialView = null;
            }
        }, 120);
    }

    // Patch Leaflet map factory to auto-hook new instances
    function patchMapFactory() {
        if (!window.L || window.__squadMapFactoryPatched) return;
        const orig = L.map;
        L.map = function (id, options) {
            const m = orig.call(this, id, options);
            onMapHooked(m, 'factory');
            return m;
        };
        window.__squadMapFactoryPatched = true;
    }

    function findExistingMap() {
        if (!window.L) return null;
        // Direct scan of window enumerable props (best effort)
        try {
            for (const k in window) {
                const v = window[k];
                if (v && typeof v === 'object' && v instanceof L.Map) {
                    return v;
                }
            }
        } catch (_) {
        }
        // Fallback: look for .leaflet-container elements & attempt to match with hidden internal _leaflet_id
        try {
            const els = document.querySelectorAll('.leaflet-container');
            if (els.length) {
                // Some Leaflet versions store map refs in L._leaflet_id keyed containers via _leaflet_id attribute
                for (const k in window) {
                    const v = window[k];
                    if (v && typeof v === 'object' && v instanceof L.Map && v._container && document.contains(v._container)) return v;
                }
            }
        } catch (_) {
        }
        return null;
    }

    function ensureMapHooked() {
        if (window.squadMap && window.squadMap._container && document.contains(window.squadMap._container)) return; // already good
        const ex = findExistingMap();
        if (ex) {
            onMapHooked(ex, 'scan');
            return;
        }
        patchMapFactory();
    }

    // Install watchdogs
    patchMapFactory();
    if (!window.__squadMapHookInterval) {
        window.__squadMapHookInterval = setInterval(ensureMapHooked, 1000);
    }
    if (!window.__squadMapDomObserver) {
        try {
            const mo = new MutationObserver(muts => {
                for (const m of muts) {
                    if (m.addedNodes) {
                        for (const n of m.addedNodes) {
                            if (n && n.nodeType === 1 && n.classList && n.classList.contains('leaflet-container')) {
                                ensureMapHooked();
                            }
                        }
                    }
                }
            });
            mo.observe(document.documentElement || document.body, {subtree: true, childList: true});
            window.__squadMapDomObserver = mo;
        } catch (_) {
        }
    }

    // New: build one-shot Sync View button in toolbar
    function buildSyncViewButtonUI() {
        try {
            if (document.getElementById('squadmaps-sync-view-button')) return; // already present
            const bars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
            if (!bars || !bars.length) {
                setTimeout(buildSyncViewButtonUI, 400);
                return;
            }
            const targetBar = bars[0]; // place in first toolbar for visibility
            const btn = document.createElement('a');
            btn.id = 'squadmaps-sync-view-button';
            btn.href = '#';
            btn.title = 'Broadcast current view (center + zoom) to others';
            btn.innerHTML = '<i class="fa-solid fa-arrows-to-circle" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>';
            Object.assign(btn.style, {
                width: '30px', height: '30px', display: 'block', background: '#171718', color: '#fff',
                textDecoration: 'none', border: '1px solid #2a2a2b'
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (!squadMap) return;
                try {
                    const c = squadMap.getCenter();
                    const z = squadMap.getZoom();
                    socket.emit('view changed', {center: {lat: c.lat, lng: c.lng}, zoom: z});
                } catch (_) {
                }
            });
            // Ensure FA available for icon
            ensureFontAwesomeOnce && ensureFontAwesomeOnce();
            targetBar.appendChild(btn);
            syncViewBtn = btn;
            if (!document.getElementById('squadmaps-sync-view-css')) {
                const st = document.createElement('style');
                st.id = 'squadmaps-sync-view-css';
                st.textContent = '#squadmaps-sync-view-button{box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset;}#squadmaps-sync-view-button:hover{background:#1f1f20;}';
                document.head.appendChild(st);
            }
        } catch (_) {
        }
    }

    // New: build one-shot Apply View button (uses pendingInitialView)
    function buildApplyViewButtonUI() {
        try {
            if (document.getElementById('squadmaps-apply-view-button')) return; // already present
            const bars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
            if (!bars || !bars.length) {
                setTimeout(buildApplyViewButtonUI, 400);
                return;
            }
            const targetBar = bars[0];
            const btn = document.createElement('a');
            btn.id = 'squadmaps-apply-view-button';
            btn.href = '#';
            btn.title = 'Apply shared view (if available)';
            btn.innerHTML = '<i class="fa-solid fa-crosshairs" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>';
            Object.assign(btn.style, {
                width: '30px', height: '30px', display: 'block', background: '#171718', color: '#fff',
                textDecoration: 'none', border: '1px solid #2a2a2b'
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (!squadMap || !pendingInitialView) return;
                applyRemoteViewIfPossible(pendingInitialView);
                pendingInitialView = null;
            });
            ensureFontAwesomeOnce && ensureFontAwesomeOnce();
            targetBar.appendChild(btn);
            applyViewBtn = btn;
            if (!document.getElementById('squadmaps-apply-view-css')) {
                const st = document.createElement('style');
                st.id = 'squadmaps-apply-view-css';
                st.textContent = '#squadmaps-apply-view-button{box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset;}#squadmaps-apply-view-button:hover{background:#1f1f20;}';
                document.head.appendChild(st);
            }
        } catch (_) {
        }
    }

    // New: attach view sync (one-shot button only; no continuous moveend emission)
    function attachViewSyncHandlers() {
        if (viewHandlersAttached) return;
        buildSyncViewButtonUI();
        buildApplyViewButtonUI();
        viewHandlersAttached = true;
    }

    function applyRemoteViewIfPossible(view) {
        if (!view || !squadMap) return false;
        try {
            const {center, zoom} = view;
            if (!center || typeof zoom !== 'number') return false;
            isApplyingRemoteView = true;
            squadMap.setView([center.lat, center.lng], zoom, {animate: false});
            return true;
        } catch (_) {
            isApplyingRemoteView = false; // fail-safe
            return false;
        }
    }

    // NEW: bootstrap orchestrates initialization and safely waits for Leaflet before wiring everything
    function bootstrap() {
        try {
            initUserColor();
        } catch (_) {
        }
        try {
            applyLiveColor(userColor);
        } catch (_) {
        }

        function startWithLeaflet() {
            try {
                addInitHooks();
            } catch (_) {
            }
            try {
                injectDrawAssetsOnce();
            } catch (_) {
            }
            try {
                ensureMapHooked();
            } catch (_) {
            }
            try {
                attachViewSyncHandlers();
            } catch (_) {
            }
            try {
                buildColorPickerUI();
            } catch (_) {
            }
            // Presence UI early (panel can exist before map ready)
            try {
                buildPresenceUI();
            } catch (_) {
            }
        }

        if (waitForLeaflet()) {
            startWithLeaflet();
            return;
        }
        // Poll briefly until Leaflet core is available, then proceed
        let tries = 0;
        const maxTries = 60; // ~30s at 500ms
        const t = setInterval(() => {
            tries++;
            if (waitForLeaflet()) {
                clearInterval(t);
                startWithLeaflet();
            } else if (tries >= maxTries) {
                clearInterval(t);
                // Leaflet not detected; defer to watchdogs (patchMapFactory/ensureMapHooked) to catch later
            }
        }, 500);
    }

    // History / URL change hooks (restored)
    if (!window.__squadSyncHistoryPatched) {
        window.__squadSyncHistoryPatched = true;
        const _pushState = history.pushState;
        history.pushState = function () {
            const rv = _pushState.apply(this, arguments);
            setTimeout(() => emitMapChangedIfNeeded('pushState'), 10);
            return rv;
        };
        const _replaceState = history.replaceState;
        history.replaceState = function () {
            const rv = _replaceState.apply(this, arguments);
            setTimeout(() => emitMapChangedIfNeeded('replaceState'), 10);
            return rv;
        };
        window.addEventListener('popstate', () => setTimeout(() => emitMapChangedIfNeeded('popstate'), 10));
    }

    bootstrap();

    // Polling fallback for URL change (restored)
    if (!window.__squadSyncPoller) {
        window.__squadSyncPoller = setInterval(() => {
            const path = window.location.pathname + window.location.search;
            if (path !== currentMap) emitMapChangedIfNeeded('poll');
        }, 1500);
    }

    // Diagnostics listeners (restored if missing) & instrumentation
    function attachGlobalDiagnostics() {
        if (window.__squadSyncDiagAttached) return;
        window.__squadSyncDiagAttached = true;
        ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(type => {
            window.addEventListener(type, e => {
                if (!window.__squadDrawVerbose) return;
                lastPointer = {x: e.clientX, y: e.clientY};
                const active = !!customDraw || !!squadMap?._toolbars?.draw?._activeMode;
                console.log('[evt]', type, 't=', e.target.tagName, 'manual=', !!customDraw, 'nativeActive=', !!squadMap?._toolbars?.draw?._activeMode);
            }, true);
        });
    }

    attachGlobalDiagnostics();

    function attachMapDomDebug() {
        if (mapDomDebugAttached || !squadMap || !squadMap._container) return;
        const c = squadMap._container;
        ['click', 'mousedown', 'mouseup'].forEach(t => c.addEventListener(t, e => {
            if (window.__squadDrawVerbose) console.log('[map-dom]', t, 'target=', e.target.tagName);
        }, true));
        mapDomDebugAttached = true;
    }

    // Expose helper
    window.__squadDrawDebugInfo = () => ({
        hasLeaflet: !!window.L,
        drawLoaded: !!(window.L && L.Draw),
        activeMode: squadMap?._toolbars?.draw?._activeMode?.handler?.type,
        draggingEnabled: !!(squadMap?.dragging?.enabled()),
        featureGroupSize: drawnItems ? Object.keys(drawnItems._layers).length : 0,
        proxyActive: clickProxyDiv ? clickProxyDiv.style.pointerEvents : 'none',
        customDrawActive: !!customDraw,
        leafletVersion: window.L && L.version,
        manualActive: !!customDraw,
        manualMode: customDraw ? customDraw.type : null,
        manualPoints: customDraw ? customDraw.points.length : 0,
        verbose: !!window.__squadDrawVerbose,
        userColor,
        continuousModeEnabled,
        continuousActiveType,
        lastDrawButtonSelector,
        currentDrawCreationOccurred,
        currentDrawSessionId,
        lastToolbarClickAt,
        // Presence debug
        presenceUsersCount: Object.keys(presenceUsers).length,
        followingUserId
    });

    // ---------------- Socket Handlers ----------------
    socket.on('state init', state => {
        hasReceivedState = true;
        if (!state) return;
        serverCurrentMap = state.currentMap || null;
        pendingReplayClicks = state.clicks || [];
        const desired = state.currentMap;
        const here = window.location.pathname + window.location.search;
        if (desired && desired !== here) {
            console.log('[sync] Navigate to shared map', desired);
            window.location = window.location.origin + desired;
            return;
        }
        // Presence snapshot
        try {
            ensurePresenceLayer();
            buildPresenceUI();
            (state.users || []).forEach(u => upsertPresenceUser(u));
            // Apply follow preference if set and target exists
            try {
                const savedFollow = localStorage.getItem(FOLLOW_KEY) || '';
                followingUserId = savedFollow || null;
                if (followingUserId && presenceUsers[followingUserId]) {
                    const u = presenceUsers[followingUserId];
                    if (u.view) applyRemoteViewIfPossible(u.view);
                }
            } catch (_) {
            }
        } catch (_) {
        }
        // Apply initial view if provided (manual only: store for Apply View button)
        if (state.view) {
            pendingInitialView = state.view;
        }
        setTimeout(() => {
            if (pendingReplayClicks.length) {
                console.log('[sync] Replaying', pendingReplayClicks.length, 'clicks');
                replayClicksSequential(pendingReplayClicks.slice());
                pendingReplayClicks = [];
            }
        }, 800);
        if (state.drawings?.length) {
            const apply = () => {
                runWhenDrawReady(() => {
                    state.drawings.forEach(s => {
                        if (!s?.id || !s.geojson || layerIdMap[s.id]) return;
                        const layer = geojsonToLayer(s.geojson);
                        if (layer) {
                            layer._drawSyncId = s.id;
                            layerIdMap[s.id] = layer;
                            drawnItems.addLayer(layer);
                            ensureLayerEditable(layer);
                        }
                    });
                });
            };
            setTimeout(apply, 600);
        }
    });

    socket.on('point clicked', latlng => {
        if (!squadMap) {
            console.warn('[sync] Map not ready for point');
            // Reload to try and re-hook
            window.location.reload();
            return;
        }
        for (const k of Object.keys(squadMap._layers)) {
            const layer = squadMap._layers[k];
            if (layer?._latlng?.equals && layer._latlng.equals(latlng) && layer?._events?.click) {
                layer.fire('click', 'r');
                return;
            }
        }
    });

    // Socket id + initial username send
    socket.on('connect', () => {
        try {
            mySocketId = socket.id;
        } catch (_) {
            mySocketId = mySocketId || null;
        }
        // Remove self cursor marker if created before id known
        try {
            if (mySocketId && presenceUsers[mySocketId] && presenceUsers[mySocketId].marker && presenceLayer) {
                try {
                    presenceLayer.removeLayer(presenceUsers[mySocketId].marker);
                } catch (_) {
                }
                presenceUsers[mySocketId].marker = null;
            }
        } catch (_) {
        }
        // Send saved username if exists
        try {
            const saved = localStorage.getItem(USERNAME_KEY);
            if (saved) socket.emit('username set', {name: String(saved).slice(0, 32)});
        } catch (_) {
        }
    });

    socket.on('user joined', (u) => {
        if (!u || !u.id) return;
        upsertPresenceUser(u);
    });
    socket.on('user left', (u) => {
        if (!u || !u.id) return;
        removePresenceUser(u.id);
    });
    socket.on('user updated', (u) => {
        if (!u || !u.id) return;
        upsertPresenceUser(u);
    });
    socket.on('presence update', (delta) => {
        if (!delta || !delta.id) return;
        const u = presenceUsers[delta.id] || {id: delta.id};
        if (delta.tool !== undefined) u.tool = delta.tool;
        if (delta.cursor) u.cursor = delta.cursor;
        if (delta.view) u.view = delta.view;
        upsertPresenceUser(u);
        if (followingUserId && delta.id === followingUserId) {
            if (delta.view) {
                applyRemoteViewIfPossible(delta.view);
            }
        }
    });

    socket.on('map changed', msg => {
        serverCurrentMap = msg;
        if (window.location.pathname + window.location.search === msg) {
            console.log('[sync] Map already correct');
            return;
        }
        suppressNextMapEmit = true;
        sessionStorage.setItem(SUPPRESS_KEY, '1');
        window.location = window.location.origin + msg;
    });

    // New: apply view changes from others (one-shot on receipt)
    socket.on('view changed', view => {
        if (!view) return;
        if (!squadMap) {
            pendingInitialView = view;
            return;
        }
        applyRemoteViewIfPossible(view);
    });

    socket.on('draw create', shape => {
        if (!shape?.id || !shape.geojson || layerIdMap[shape.id]) return;
        const add = () => {
            const layer = geojsonToLayer(shape.geojson);
            if (layer) {
                layer._drawSyncId = shape.id;
                layerIdMap[shape.id] = layer;
                drawnItems.addLayer(layer);
                ensureLayerEditable(layer); // remote create immediate edit support
            }
        };
        runWhenDrawReady(add);
    });
    socket.on('draw edit', shapes => {
        if (!Array.isArray(shapes)) return;
        const applyEdits = () => {
            shapes.forEach(s => {
                const existing = layerIdMap[s.id];
                if (!existing) {
                    const l = geojsonToLayer(s.geojson);
                    if (l) {
                        l._drawSyncId = s.id;
                        layerIdMap[s.id] = l;
                        drawnItems.addLayer(l);
                        ensureLayerEditable(l);
                    }
                    return;
                }
                drawnItems.removeLayer(existing);
                const nl = geojsonToLayer(s.geojson);
                if (nl) {
                    nl._drawSyncId = s.id;
                    layerIdMap[s.id] = nl;
                    drawnItems.addLayer(nl);
                    ensureLayerEditable(nl);
                }
            });
        };
        runWhenDrawReady(applyEdits);
    });
    socket.on('draw delete', ids => {
        if (!Array.isArray(ids)) return;
        const doDel = () => {
            ids.forEach(id => {
                const l = layerIdMap[id];
                if (l) {
                    drawnItems.removeLayer(l);
                    delete layerIdMap[id];
                }
            });
        };
        runWhenDrawReady(doDel);
    });

    // NEW: receive live draw progress (temporary preview only)
    socket.on('draw progress', payload => {
        try {
            if (!payload || typeof payload !== 'object') return;
            const { id, shapeType, points, end } = payload;
            if (!id) return;
            if (shapeType !== 'polyline' && shapeType !== 'polygon' && shapeType !== 'rectangle' && shapeType !== 'circle') return;
            const apply = () => {
                if (!squadMap || !window.L) return;
                // Lazily ensure the progress overlay group exists so we can render previews even before full toolbar init
                try {
                    if (!progressItems) {
                        progressItems = new L.FeatureGroup();
                        squadMap.addLayer(progressItems);
                        try { progressItems.bringToFront && progressItems.bringToFront(); } catch(_) {}
                    }
                } catch(_) {}
                // Helper to start a periodic cleanup of stale previews
                function ensureProgressCleanupTimer() {
                    if (__progressCleanupTimer) return;
                    __progressCleanupTimer = setInterval(() => {
                        const now = Date.now();
                        Object.keys(inProgressLayers).forEach(k => {
                            const rec = inProgressLayers[k];
                            const last = (rec && rec.lastSeen) || 0;
                            if (now - last > 5000) {
                                try {
                                    const lay = rec && rec.layer ? rec.layer : rec;
                                    if (lay) (progressItems || drawnItems).removeLayer(lay);
                                } catch(_) {}
                                delete inProgressLayers[k];
                            }
                        });
                    }, 2000);
                }
                ensureProgressCleanupTimer();
                if (end) {
                    const rec = inProgressLayers[id];
                    if (rec) {
                        try {
                            const lay = rec.layer ? rec.layer : rec;
                            (progressItems || drawnItems).removeLayer(lay);
                        } catch (_) {}
                        delete inProgressLayers[id];
                    }
                    return;
                }
                // Build or update overlay by type
                if (shapeType === 'circle') {
                    const c = payload.center;
                    const r = payload.radius;
                    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng) || !Number.isFinite(r)) return;
                    let rec = inProgressLayers[id];
                    const style = { color: '#ffffff', weight: 2, opacity: 0.9, dashArray: '6 6', fill: false, interactive: false };
                    if (!rec) {
                        const layer = new L.Circle([c.lat, c.lng], { radius: r, ...style });
                        inProgressLayers[id] = rec = { layer, type: shapeType, lastSeen: Date.now() };
                        (progressItems || drawnItems).addLayer(layer);
                        try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                    } else {
                        try {
                            const layer = rec.layer ? rec.layer : rec;
                            layer.setLatLng([c.lat, c.lng]);
                            layer.setRadius(r);
                            try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                        } catch (_) {}
                        rec.lastSeen = Date.now();
                    }
                    return;
                }
                if (shapeType === 'rectangle') {
                    if (!Array.isArray(points) || points.length < 2) return;
                    const latlngs = points.map(p => L.latLng(p.lat, p.lng));
                    let rec = inProgressLayers[id];
                    const style = { color: '#ffffff', weight: 2, opacity: 0.9, dashArray: '6 6', fill: false, interactive: false };
                    if (!rec) {
                        const layer = new L.Polygon(latlngs, style);
                        inProgressLayers[id] = rec = { layer, type: shapeType, lastSeen: Date.now() };
                        (progressItems || drawnItems).addLayer(layer);
                        try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                    } else {
                        try {
                            const layer = rec.layer ? rec.layer : rec;
                            layer.setLatLngs([latlngs]);
                            try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                        } catch (_) {}
                        rec.lastSeen = Date.now();
                    }
                    return;
                }
                // polyline/polygon default: render as dashed polyline
                if (!Array.isArray(points) || points.length === 0) return;
                const latlngs = points.map(p => L.latLng(p.lat, p.lng));
                let rec = inProgressLayers[id];
                const style = { color: '#ffffff', weight: 3, opacity: 0.9, dashArray: '6 6', interactive: false };
                if (!rec) {
                    const layer = new L.Polyline(latlngs, style);
                    inProgressLayers[id] = rec = { layer, type: shapeType, lastSeen: Date.now() };
                    (progressItems || drawnItems).addLayer(layer);
                    try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                } else {
                    try {
                        const layer = rec.layer ? rec.layer : rec;
                        layer.setLatLngs(latlngs);
                        try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                    } catch (_) {
                        try {
                            const layer = rec.layer ? rec.layer : rec;
                            layer.setLatLngs([latlngs]);
                            try { layer.bringToFront && layer.bringToFront(); } catch(_) {}
                        } catch (__) {}
                    }
                    rec.lastSeen = Date.now();
                }
            };
            if (squadMap && window.L) {
                apply();
            } else {
                runWhenDrawReady(apply);
            }
        } catch (_) {}
    });

    function forceEnableAllLayerEditing() {
        if (!drawnItems) return;
        drawnItems.eachLayer(l => {
            try {
                ensureLayerEditable(l);
                if (l.editing && !l.editing.enabled()) l.editing.enable();
            } catch (_) {
            }
        });
    }

    // NEW: restore missing disableAllLayerEditing used by edit stop handler
    function disableAllLayerEditing() {
        if (!drawnItems) return;
        drawnItems.eachLayer(l => {
            try {
                if (l.editing && l.editing.enabled()) l.editing.disable();
            } catch (_) {
            }
        });
    }

    // Helper to attach Leaflet.Draw editing capability for manually/externally created layers
    function ensureLayerEditable(layer) {
        if (!layer || layer.editing) return; // already has editing or invalid
        try {
            if (layer instanceof L.Polygon || (layer instanceof L.Polyline && !(layer instanceof L.Polygon))) {
                if (window.L && L.Edit && L.Edit.Poly) layer.editing = new L.Edit.Poly(layer);
            } else if (layer instanceof L.Circle || layer instanceof L.Rectangle) {
                if (window.L && L.Edit && L.Edit.SimpleShape) layer.editing = new L.Edit.SimpleShape(layer);
            }
        } catch (_) {
        }
    }

    // NEW: helpers for live draw progress emission
    function __collectActiveHandlerPoints(handler, type) {
        try {
            if (!handler) return null;
            // Polygon/Polyline via internal poly or markers
            if (type === 'polyline' || type === 'polygon') {
                let arrPts = null;
                if (handler._poly && typeof handler._poly.getLatLngs === 'function') {
                    const lls = handler._poly.getLatLngs();
                    if (type === 'polygon') {
                        const ring = Array.isArray(lls?.[0]) ? lls[0] : lls || [];
                        arrPts = ring.map(ll => ({ lat: ll.lat, lng: ll.lng }));
                    } else {
                        const arr = Array.isArray(lls?.[0]) ? lls[0] : lls || [];
                        arrPts = arr.map(ll => ({ lat: ll.lat, lng: ll.lng }));
                    }
                } else if (Array.isArray(handler._markers) && handler._markers.length) {
                    arrPts = handler._markers.map(m => { const ll = m.getLatLng(); return { lat: ll.lat, lng: ll.lng }; });
                } else {
                    arrPts = [];
                }
                // Append current mouse position if available
                try {
                    const cur = handler._currentLatLng;
                    if (cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lng)) {
                        arrPts = (arrPts || []).concat([{ lat: cur.lat, lng: cur.lng }]);
                    }
                } catch (_) {}
                return arrPts;
            }
            // Rectangle: use live _shape bounds/corners if present
            if (type === 'rectangle') {
                const shp = handler._shape;
                if (shp && typeof shp.getLatLngs === 'function') {
                    const arr = shp.getLatLngs();
                    const ring = Array.isArray(arr) && arr.length ? (Array.isArray(arr[0]) ? arr[0] : arr) : [];
                    if (!ring.length) return null;
                    return ring.map(ll => ({ lat: ll.lat, lng: ll.lng }));
                }
                return null;
            }
            // Circle: return special object with center+radius
            if (type === 'circle') {
                const shp = handler._shape;
                if (shp && typeof shp.getLatLng === 'function' && typeof shp.getRadius === 'function') {
                    const c = shp.getLatLng();
                    return { center: { lat: c.lat, lng: c.lng }, radius: shp.getRadius() };
                }
                // Some builds track _startLatLng while dragging; fallback: no emit until shape exists
                return null;
            }
        } catch (_) {}
        return null;
    }
    function __startProgressTrackingIfNeeded(layerType) {
        if (!/polyline|polygon|rectangle|circle/.test(layerType)) return;
        currentProgressId = 'p_' + generateId();
        currentProgressType = layerType;
        __progressLastSig = '';
        if (__progressInterval) try { clearInterval(__progressInterval); } catch (_) {}
        __progressInterval = setInterval(() => {
            try {
                const sample = __collectActiveHandlerPoints(activeDrawHandler, currentProgressType);
                if (!sample) return;
                // Compute signature and payload
                let sig, payload;
                if (currentProgressType === 'circle' && sample.center && typeof sample.radius === 'number') {
                    sig = `${sample.center.lat.toFixed(6)},${sample.center.lng.toFixed(6)}:${Math.round(sample.radius)}`;
                    payload = { id: currentProgressId, shapeType: currentProgressType, center: sample.center, radius: sample.radius };
                } else {
                    const pts = Array.isArray(sample) ? sample : [];
                    if (!pts.length) return;
                    sig = JSON.stringify(pts);
                    payload = { id: currentProgressId, shapeType: currentProgressType, points: pts };
                }
                if (sig === __progressLastSig) return;
                __progressLastSig = sig;
                socket.emit('draw progress', payload);
            } catch (_) {}
        }, 120);
    }

    function __stopProgressTransmission(sendEnd) {
        try {
            if (__progressInterval) clearInterval(__progressInterval);
        } catch (_) {
        }
        __progressInterval = null;
        if (sendEnd && currentProgressId && currentProgressType) {
            try {
                socket.emit('draw progress', {
                    id: currentProgressId,
                    shapeType: currentProgressType,
                    points: [],
                    end: true
                });
            } catch (_) {
            }
        }
        currentProgressId = null;
        currentProgressType = null;
        __progressLastSig = '';
    }

    // Restored helpers (were accidentally truncated)
    function disablePointerBlockers() {
        if (!squadMap || !squadMap._container) return;
        editBlockers = [];
        squadMap._container.querySelectorAll('canvas, .leaflet-triggers-pane, .Ground_ground__container__Hoq0Z').forEach(el => {
            try {
                const pe = getComputedStyle(el).pointerEvents;
                if (pe !== 'none') {
                    editBlockers.push({el, prev: el.style.pointerEvents});
                    el.style.pointerEvents = 'none';
                }
            } catch (_) {
            }
        });
        if (editBlockers.length) dlog('Disabled pointer events on', editBlockers.length, 'elements for editing');
    }

    function restorePointerBlockers() {
        editBlockers.forEach(rec => {
            try {
                rec.el.style.pointerEvents = rec.prev || '';
            } catch (_) {
            }
        });
        if (editBlockers.length) dlog('Restored pointer events on blockers');
        editBlockers = [];
    }

    function patchEditHandlersOnce() {
        if (!window.L || !L.Edit || L.Edit.__patched_manual) return;
        const poly = L.Edit.Poly && L.Edit.Poly.prototype;
        if (poly) {
            ['_onMarkerDragStart', '_onMarkerDrag', '_onMarkerDragEnd'].forEach(fn => {
                if (poly[fn] && !poly[fn].__patched_custom) {
                    const orig = poly[fn];
                    poly[fn] = function () {
                        dlog('edit', fn, 'layer id=', this._poly && this._poly._leaflet_id);
                        return orig.apply(this, arguments);
                    };
                    poly[fn].__patched_custom = true;
                }
            });
        }
        L.Edit.__patched_manual = true;
    }

    patchEditHandlersOnce();

    // Inject (or update) improved edit vertex styling (larger, orange center, easier hit area)
    (function ensureVertexCss() {
        const ID = 'squadmaps-edit-vertex-css';
        const css = `.leaflet-editing-icon{width:14px!important;height:14px!important;margin-left:-7px!important;margin-top:-7px!important;border:2px solid #fff!important;border-radius:50%!important;background:#ff6600!important;box-shadow:0 0 4px rgba(0,0,0,.7);cursor:move;box-sizing:border-box;}
.leaflet-editing-icon::after{content:'';position:absolute;left:-6px;top:-6px;right:-6px;bottom:-6px;border-radius:50%;background:rgba(255,102,0,0.18);opacity:.55;pointer-events:none;}
.leaflet-editing-icon:hover::after{background:rgba(255,255,255,0.35);opacity:.75;}
.leaflet-editing-icon{pointer-events:auto!important;}`;
        const existing = document.getElementById(ID);
        if (existing) {
            existing.textContent = css;
            return;
        }
        const st = document.createElement('style');
        st.id = ID;
        st.textContent = css;
        document.head.appendChild(st);
    })();

    // Radial marker icon selector shown after placing a marker
    let markerRadialEl = null;
    // Track open state globally to coordinate with continuous mode
    window.__squadMarkerRadialOpen = false;
    let __squadMarkerRadialClosedCbs = [];

    function onMarkerRadialClosedOnce(cb) {
        if (!cb) return;
        if (!window.__squadMarkerRadialOpen) {
            try {
                cb();
            } catch (_) {
            }
            return;
        }
        __squadMarkerRadialClosedCbs.push(cb);
    }

    function hideMarkerRadial() {
        if (markerRadialEl && markerRadialEl.parentElement) markerRadialEl.parentElement.removeChild(markerRadialEl);
        markerRadialEl = null;
        window.__squadMarkerRadialOpen = false;
        // flush deferred callbacks
        try {
            const cbs = __squadMarkerRadialClosedCbs.slice();
            __squadMarkerRadialClosedCbs.length = 0;
            cbs.forEach(fn => {
                try {
                    fn();
                } catch (_) {
                }
            });
        } catch (_) {
        }
        try {
            window.removeEventListener('keydown', onRadialKey);
        } catch (_) {
        }
        try {
            document.removeEventListener('click', onDocClick, true);
        } catch (_) {
        }
        try {
            squadMap && squadMap.off && squadMap.off('movestart', hideMarkerRadial);
        } catch (_) {
        }
        try {
            squadMap && squadMap.off && squadMap.off('zoomstart', hideMarkerRadial);
        } catch (_) {
        }
    }

    function onRadialKey(e) {
        if (e.key === 'Escape') hideMarkerRadial();
    }

    function onDocClick(e) {
        if (!markerRadialEl) return;
        if (markerRadialEl.contains(e.target)) return;
        hideMarkerRadial();
    }

    function showMarkerRadialMenu(marker) {
        try {
            hideMarkerRadial();
        } catch (_) {
        }
        if (!squadMap || !marker) return;
        window.__squadMarkerRadialOpen = true;
        // Position relative to the map container so containerPoint coordinates align
        const centerPt = squadMap.latLngToContainerPoint(marker.getLatLng());
        const N = AVAILABLE_MARKER_ICONS.length;
        const radius = 84; // px distance from center
        const wrap = document.createElement('div');
        wrap.id = 'squadmaps-marker-radial';
        Object.assign(wrap.style, {
            position: 'absolute', left: centerPt.x + 'px', top: centerPt.y + 'px', zIndex: 10000,
            width: '0', height: '0', pointerEvents: 'none'
        });
        AVAILABLE_MARKER_ICONS.forEach((name, idx) => {
            const ang = (Math.PI * 2 * idx) / N - Math.PI / 2; // start at top
            const x = Math.cos(ang) * radius;
            const y = Math.sin(ang) * radius;
            const a = document.createElement('a');
            a.href = '#';
            a.setAttribute('data-icon', name);
            a.innerHTML = `<i class="fa-solid fa-${name}"></i>`;
            Object.assign(a.style, {
                position: 'absolute',
                left: `${x}px`,
                top: `${y}px`,
                transform: 'translate(-50%,-50%)',
                width: '44px',
                height: '44px',
                borderRadius: '50%',
                background: name === currentMarkerIcon ? '#2563eb' : '#171718',
                border: '1px solid #2a2a2b',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 6px rgba(0,0,0,0.45)',
                pointerEvents: 'auto'
            });
            a.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                currentMarkerIcon = name;
                saveMarkerIconChoice();
                marker.__faIconName = name;
                try {
                    marker.setIcon(buildFaDivIcon(name, userColor));
                } catch (_) {
                }
                // Update future marker placements to use this icon
                try {
                    if (drawControlRef && drawControlRef.options && drawControlRef.options.draw) {
                        drawControlRef.options.draw.marker = drawControlRef.options.draw.marker || {};
                        drawControlRef.options.draw.marker.icon = buildFaDivIcon(currentMarkerIcon, userColor);
                    }
                } catch (_) {
                }
                // Emit an edit for this marker to sync new icon
                try {
                    const id = marker._drawSyncId;
                    if (id) {
                        const geojson = layerToSerializable(marker);
                        socket.emit('draw edit', [{id, geojson}]);
                    }
                } catch (_) {
                }
                hideMarkerRadial();
            });
            wrap.appendChild(a);
        });
        // Center pulse (non-interactive)
        const dot = document.createElement('div');
        Object.assign(dot.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            transform: 'translate(-50%,-50%)',
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: '#fff8'
        });
        wrap.appendChild(dot);
        // Append inside the map container so positioning is correct
        try {
            squadMap._container.style.position = squadMap._container.style.position || 'relative';
        } catch (_) {
        }
        (squadMap._container || document.body).appendChild(wrap);
        markerRadialEl = wrap;
        window.addEventListener('keydown', onRadialKey);
        document.addEventListener('click', onDocClick, true);
        try {
            squadMap.on && squadMap.on('movestart', hideMarkerRadial);
        } catch (_) {
        }
        try {
            squadMap.on && squadMap.on('zoomstart', hideMarkerRadial);
        } catch (_) {
        }
        // Ensure FA CSS present for the icons
        ensureFontAwesomeOnce();
        // Ensure radial CSS
        if (!document.getElementById('squadmaps-marker-radial-css')) {
            const st = document.createElement('style');
            st.id = 'squadmaps-marker-radial-css';
            st.textContent = `#squadmaps-marker-radial i{font-size:18px}`;
            document.head.appendChild(st);
        }
    }

    // --- Minimal in-game units integration (non-invasive) ---
    (function installInGameUnits() {
        function key() {
            try {
                const u = new URL(location.href);
                return `name=${u.searchParams.get('name')||''}|layer=${u.searchParams.get('layer')||''}`;
            } catch(_) { return location.pathname+location.search; }
        }
        const STORE = 'squadmapsUnitsKByMapV1';
        function loadK() {
            try {
                const all = JSON.parse(localStorage.getItem(STORE)||'{}')||{};
                const rec = all[key()];
                if (rec && typeof rec.k === 'number' && rec.k > 0) return rec.k;
            } catch(_){ }
            return 0.01; // default scale: 0.01 meters per Leaflet unit
        }
        function saveK(k) {
            if (!Number.isFinite(k) || k <= 0) return;
            try {
                const all = JSON.parse(localStorage.getItem(STORE)||'{}')||{};
                all[key()] = { k:Number(k), savedAt: Date.now() };
                localStorage.setItem(STORE, JSON.stringify(all));
            } catch(_){}}
        function fmtLen(m) {
            if (!(m>=0)) return '0 m';
            if (m < 1000) return Math.round(m) + ' m';
            const km = m/1000; return (km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)) + ' km';
        }
        function fmtArea(a) {
            if (!(a>=0)) return '0 m²';
            if (a < 1e6) return Math.round(a).toLocaleString() + ' m²';
            const km2=a/1e6; return (km2<10?km2.toFixed(3):km2.toFixed(2)) + ' km²';
        }
        function ready(){ return window.L && L.Draw && L.GeometryUtil; }
        function apply(){
            const k = loadK();
            if (!ready()) return;
            if (!L.GeometryUtil.__origReadableDistance) L.GeometryUtil.__origReadableDistance = L.GeometryUtil.readableDistance;
            if (!L.GeometryUtil.__origReadableArea) L.GeometryUtil.__origReadableArea = L.GeometryUtil.readableArea;
            L.GeometryUtil.readableDistance = function(d){ try { return fmtLen(Math.max(0, Number(d)*k)); } catch(_) { return L.GeometryUtil.__origReadableDistance.call(this,d,true); } };
            L.GeometryUtil.readableArea = function(a){ try { return fmtArea(Math.max(0, Number(a)*k*k)); } catch(_) { return L.GeometryUtil.__origReadableArea.call(this,a,true); } };
            // public tiny API
            window.setInGameUnitsScale = function(newK){ saveK(Number(newK)); apply(); };
            window.getInGameUnitsScale = function(){ return loadK(); };
            console.log('[units] in-game formatter active, k =', k);

            // Augment draw tooltip: always show width and height while drawing a rectangle (scale-corrected)
            try {
                if (L.Draw && L.Draw.Tooltip && !L.Draw.Tooltip.__squadSidePatched) {
                    const proto = L.Draw.Tooltip.prototype;
                    const origUpdate = proto.updateContent;
                    proto.updateContent = function(content){
                        try {
                            const h = window.__squadActiveDrawHandler;
                            if (h && /rectangle/.test(h.type||'') && h._shape && h._map && typeof h._shape.getBounds === 'function') {
                                const b = h._shape.getBounds();
                                const nw = b.getNorthWest && b.getNorthWest();
                                const se = b.getSouthEast && b.getSouthEast();
                                if (nw && se) {
                                    const map = h._map;
                                    const widthBase = map.distance(L.latLng(nw.lat, nw.lng), L.latLng(nw.lat, se.lng));
                                    const heightBase = map.distance(L.latLng(nw.lat, nw.lng), L.latLng(se.lat, nw.lng));
                                    if (Number.isFinite(widthBase) && Number.isFinite(heightBase)) {
                                        let wStr, hStr;
                                        try { wStr = L.GeometryUtil.readableDistance(widthBase); } catch(_) { wStr = fmtLen(Math.max(0, Number(widthBase) * loadK())); }
                                        try { hStr = L.GeometryUtil.readableDistance(heightBase); } catch(_) { hStr = fmtLen(Math.max(0, Number(heightBase) * loadK())); }
                                        const baseSub = (content && content.subtext) ? String(content.subtext) : '';
                                        const prefix = baseSub ? (baseSub + '<br>') : '';
                                        const appended = prefix + 'Width: ' + wStr + '<br>Height: ' + hStr;
                                        content = Object.assign({}, content || {}, { subtext: appended });
                                    }
                                }
                            }
                        } catch(_) {}
                        return origUpdate.call(this, content);
                    };
                    L.Draw.Tooltip.__squadSidePatched = true;
                }
            } catch(_) {}

            // Ensure polygon/rectangle area uses planar area based on current map scale (Leaflet units)
            try {
                if (L.GeometryUtil && !L.GeometryUtil.__squadAreaPatched) {
                    if (!L.GeometryUtil.__origGeodesicArea) L.GeometryUtil.__origGeodesicArea = L.GeometryUtil.geodesicArea;
                    L.GeometryUtil.geodesicArea = function(latLngs){
                        try {
                            const map = window.squadMap;
                            // If projection isn't available, fall back to Leaflet's original implementation
                            if (!map || !map.options || !map.options.crs || typeof map.options.crs.project !== 'function') {
                                try { return L.GeometryUtil.__origGeodesicArea.apply(this, arguments); } catch(__){ return 0; }
                            }
                            // Unwrap ring if nested (Polygon first ring)
                            const ring = (Array.isArray(latLngs) && Array.isArray(latLngs[0])) ? latLngs[0] : latLngs;
                            if (!Array.isArray(ring) || ring.length < 3) return 0;
                            // Project to CRS units (consistent with map.distance under CRS.Simple) and compute planar area
                            const pts = ring.map(ll => map.options.crs.project(ll));
                            let sum = 0;
                            for (let i=0, n=pts.length; i<n; i++) {
                                const a = pts[i];
                                const b = pts[(i+1)%n];
                                sum += (a.x * b.y - b.x * a.y);
                            }
                            return Math.abs(sum) * 0.5; // CRS units squared (e.g., image units)
                        } catch(_) {
                            try { return L.GeometryUtil.__origGeodesicArea.apply(this, arguments); } catch(__){ return 0; }
                        }
                    };
                    L.GeometryUtil.__squadAreaPatched = true;
                }
            } catch(_) {}
        }
        // try now, then poll until Leaflet.Draw is present
        if (ready()) apply(); else {
            let tries=0; const t=setInterval(() => { tries++; if (ready()){ clearInterval(t); apply(); } if (tries>120) clearInterval(t); }, 200);
        }
    })();
})();
