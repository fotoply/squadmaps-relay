// filepath: src/userscript/modules/toolbar-extras.js
// Toolbar extras: drawing color picker (with recent colors) and continuous drawing toggle.
// Safe to call multiple times; attaches once when the draw toolbar is present.

let __extrasInitOnce = false;
let __extrasPollTimer = null;
let __extrasSyncedOnce = false;
const COLOR_KEY = 'squadmapsUserColor';
const RECENT_KEY = 'squadmapsRecentColors';
const CONT_KEY = 'squadmapsContinuousMode';

function ensureFA() {
  if (document.getElementById('squadmaps-fa')) return;
  const link = document.createElement('link');
  link.id = 'squadmaps-fa';
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  document.head.appendChild(link);
}

function loadColor() {
  try { const c = localStorage.getItem(COLOR_KEY) || '#ff6600'; return /^#?[0-9a-fA-F]{6}$/.test(c) ? (c[0] === '#' ? c : '#' + c) : '#ff6600'; } catch (_) { return '#ff6600'; }
}
function saveColor(c) { try { localStorage.setItem(COLOR_KEY, c); } catch (_) {} }
function loadRecent() { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => /^#[0-9a-fA-F]{6}$/.test(String(x))) : []; } catch (_) { return []; } }
function saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10))); } catch (_) {} }

function addRecent(c) {
  const rec = loadRecent();
  const val = c.toLowerCase();
  if (!rec.includes(val)) { rec.unshift(val); saveRecent(rec); }
}

function buildFaDivIcon(iconName, colorHex) {
  ensureFA();
  // CSS baseline for FA markers
  if (!document.getElementById('squadmaps-fa-marker-css')) {
    const st = document.createElement('style'); st.id = 'squadmaps-fa-marker-css'; st.textContent = `.squad-fa-marker-wrap{background:transparent!important;border:0!important;}
.squad-fa-marker-wrap .squad-fa-marker{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.squad-fa-marker-wrap i{pointer-events:none;}`; document.head.appendChild(st);
  }
  const icon = iconName || 'location-dot';
  const color = (colorHex && /^#?[0-9a-fA-F]{6}$/.test(colorHex)) ? (colorHex[0] === '#' ? colorHex : ('#' + colorHex)) : '#ff6600';
  const size = 48, fontSize = 35;
  const centerAnchored = icon === 'crosshairs' || icon === 'circle';
  const anchor = centerAnchored ? [size/2, size/2] : [Math.round(size/2), size - 5];
  const html = `<div class="squad-fa-marker"><i class="fa-solid fa-${icon}" style="color:${color};font-size:${fontSize}px;line-height:1"></i></div>`;
  return L.divIcon({ className: 'leaflet-div-icon squad-fa-marker-wrap', html, iconSize: [size,size], iconAnchor: anchor });
}

function applyLiveColorToDrawOptions(col) {
  try {
    const map = window.squadMap; const ctrl = map && map.__squadmapsDrawControl;
    if (!ctrl || !ctrl.options || !ctrl.options.draw) return;
    const d = ctrl.options.draw; const c = col.toLowerCase();
    ['rectangle','circle','polygon','polyline'].forEach(k => {
      if (d[k] && d[k].shapeOptions) {
        d[k].shapeOptions.color = c;
        if (d[k].shapeOptions.fillColor !== undefined) d[k].shapeOptions.fillColor = c;
        d[k].shapeOptions.opacity = 1;
      }
    });
    // marker icon uses FA; keep icon name if set by markers module, else default
    const iconName = (d.marker && d.marker.iconName) || (window.__squadMarkerIconName) || 'location-dot';
    d.marker = d.marker || {}; d.marker.icon = buildFaDivIcon(iconName, c); d.marker.iconName = iconName;
  } catch (_) {}
}

function renderRecentPalette(container, current, onPick) {
  container.innerHTML = '';
  const rec = loadRecent();
  rec.forEach(c => {
    const b = document.createElement('div');
    b.className = 'squadmaps-recent-color' + (c.toLowerCase() === current.toLowerCase() ? ' active' : '');
    Object.assign(b.style, { width: '20px', height: '20px', border: '1px solid #555', cursor: 'pointer', background: c, boxSizing: 'border-box' });
    b.title = 'Use ' + c;
    b.addEventListener('click', () => onPick(c));
    container.appendChild(b);
  });
}

export function initToolbarExtras() {
  // Idempotent starter that can be called many times (on toolbar ready or polling)
  const isActiveMapPath = () => { try { const p = (window.location && (window.location.pathname||'')) || ''; return p.startsWith('/map'); } catch(_) { return false; } };
  let tries = 0;
  function start() {
    if (!isActiveMapPath()) return false;
    if (!window || !window.L || !window.squadMap || !(window.squadMap instanceof L.Map)) return false;
    const bars = document.querySelectorAll('.leaflet-draw-toolbar.leaflet-bar');
    if (!bars || !bars.length) { return false; }
    const editBar = Array.from(bars).find(b => b.querySelector('.leaflet-draw-edit-edit') || b.querySelector('[class*="leaflet-draw-edit-edit"]')) || bars[0];
    if (!editBar) { return false; }
    // If already attached in current DOM, just ensure live options match and exit
    if (document.getElementById('squadmaps-color-button')) {
      try { const c = loadColor(); applyLiveColorToDrawOptions(c); if (!__extrasSyncedOnce) { console.log('[extras]', new Date().toISOString(), 'already attached; synced live color/options'); __extrasSyncedOnce = true; } } catch (_) {}
      return true;
    }

    ensureFA();

    // Color button with hidden input
    const colorBtn = document.createElement('a');
    colorBtn.id = 'squadmaps-color-button';
    Object.assign(colorBtn.style, { position:'relative', width:'30px', height:'30px', display:'block', boxSizing:'border-box', border:'none', cursor:'pointer', padding:'0' });
    const inner = document.createElement('span');
    Object.assign(inner.style, { position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'16px', lineHeight:'1', border:'2px solid rgba(255,255,255,0.35)', boxSizing:'border-box', pointerEvents:'none' });
    inner.innerHTML = '<i class="fa-solid fa-eye-dropper"></i>';
    colorBtn.appendChild(inner);
    const input = document.createElement('input'); input.type = 'color'; Object.assign(input.style, { position:'absolute', inset:0, width:'100%', height:'100%', opacity:'0', cursor:'pointer', border:'0', padding:'0', margin:'0', background:'transparent' });
    colorBtn.appendChild(input);
    editBar.appendChild(colorBtn);

    // Compute readable icon color (black/white) based on background luminance
    const updateEyedropperContrast = (hex) => {
      try {
        const c = (hex && hex[0] === '#' ? hex : '#' + hex).slice(1);
        const r = parseInt(c.substring(0,2), 16) / 255;
        const g = parseInt(c.substring(2,4), 16) / 255;
        const b = parseInt(c.substring(4,6), 16) / 255;
        const lin = (v) => (v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4));
        const L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
        // threshold ~0.5: use black for light colors, white for dark
        inner.style.color = (L > 0.5 ? '#000' : '#fff');
        // Also tune the inner outline for very light bg
        inner.style.borderColor = L > 0.7 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)';
      } catch (_) {}
    };

    const palette = document.createElement('div'); palette.id = 'squadmaps-recent-colors'; Object.assign(palette.style, { display:'flex', flexWrap:'wrap', gap:'2px', padding:'4px 2px', background:'#222', borderRadius:'4px', marginTop:'4px', boxShadow:'0 1px 3px rgba(0,0,0,0.4)', pointerEvents:'auto' });
    editBar.parentElement && editBar.parentElement.appendChild(palette);

    const dispatchUserColorChanged = (col) => {
      try { window.dispatchEvent(new CustomEvent('squadmaps:userColorChanged', { detail: { color: col } })); } catch (_) {}
    };

    const setColor = (c) => {
      const col = (c[0] === '#' ? c : '#' + c).toLowerCase();
      window.userColor = col;
      saveColor(col); addRecent(col);
      colorBtn.style.backgroundColor = col; colorBtn.style.backgroundImage = 'none';
      updateEyedropperContrast(col);
      renderRecentPalette(palette, col, setColor);
      applyLiveColorToDrawOptions(col);
      // Notify presence module so it can emit and update UI
      dispatchUserColorChanged(col);
    };

    const initial = loadColor();
    setColor(initial);
    input.value = initial;
    input.addEventListener('input', (e) => { const live = e.target.value; colorBtn.style.backgroundColor = live; updateEyedropperContrast(live); applyLiveColorToDrawOptions(live); });
    input.addEventListener('change', (e) => { setColor(e.target.value); });

    // Continuous mode button
    const contBtn = document.createElement('a');
    contBtn.id = 'squadmaps-continuous-button'; contBtn.href = '#'; contBtn.title = 'Toggle continuous drawing';
    contBtn.innerHTML = '<i class="fa-solid fa-infinity" aria-hidden="true" style="display:block;line-height:30px;text-align:center;font-size:15px;pointer-events:none;"></i>';
    Object.assign(contBtn.style, { width:'30px', height:'30px', display:'block', background:'#171718', color:'#fff', textDecoration:'none', border:'1px solid #2a2a2b', boxShadow:'0 1px 2px #000a,0 0 0 1px #000 inset' });
    editBar.appendChild(contBtn);
    let enabled = true; try { const v = localStorage.getItem(CONT_KEY); if (v !== null) enabled = v === '1'; } catch (_) {}
    const syncCont = () => { contBtn.className = enabled ? 'active' : ''; };
    contBtn.addEventListener('click', (e) => { e.preventDefault(); enabled = !enabled; try { localStorage.setItem(CONT_KEY, enabled ? '1' : '0'); } catch (_) {} syncCont(); window.__squadContinuousMode = enabled; });
    window.__squadContinuousMode = enabled; syncCont();

    if (!document.getElementById('squadmaps-color-toolbar-css')) {
      const st = document.createElement('style'); st.id = 'squadmaps-color-toolbar-css';
      st.textContent = `#squadmaps-color-button{border:1px solid #2a2a2b}
#squadmaps-color-button:hover{filter:brightness(1.08)}
#squadmaps-recent-colors{width:112px; pointer-events:auto}
#squadmaps-recent-colors .squadmaps-recent-color{pointer-events:auto}
#squadmaps-recent-colors .squadmaps-recent-color.active{outline:2px solid #0f0}
#squadmaps-continuous-button{background:#171718 !important; border:1px solid #2a2a2b !important; color:#fff !important; box-shadow:0 1px 2px #000a,0 0 0 1px #000 inset}
#squadmaps-continuous-button:hover{background:#1f1f20 !important}
#squadmaps-continuous-button.active{background:#16a34a !important; border-color:#1fd367 !important; box-shadow:0 0 0 2px #ffffff33 inset,0 0 10px 2px #16ff8b99,0 0 0 1px #0c4024 !important}
/* Brighten built-in Leaflet/Leaflet.Draw toolbar icons */
.leaflet-bar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button),
.leaflet-draw-toolbar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button){
  filter: brightness(3) contrast(1.12) saturate(1.08);
}
.leaflet-bar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):hover,
.leaflet-draw-toolbar a:not(#squadmaps-color-button):not(#squadmaps-continuous-button):hover{
  filter: brightness(4) contrast(1.18) saturate(1.12);
}`;
      document.head.appendChild(st);
    }

    try { console.log('[extras]', new Date().toISOString(), 'attached color + continuous controls'); } catch(_) {}
    return true;
  }

  // Try immediately
  if (start()) { /* attached */ }

  // Listen for draw toolbar ready events (from draw module) and re-attach when needed
  if (!__extrasInitOnce) {
    try { window.addEventListener('squadmaps:drawToolbarReady', () => { try { console.log('[extras]', new Date().toISOString(), 'drawToolbarReady event'); start(); } catch (_) {} }); } catch (_) {}
    __extrasInitOnce = true; // guard listener registration only
  }

  // Fallback: short polling in case event missed during first load
  if (!__extrasPollTimer) {
    __extrasPollTimer = setInterval(() => { tries++; if (start()) { clearInterval(__extrasPollTimer); __extrasPollTimer = null; } if (tries > 120) { clearInterval(__extrasPollTimer); __extrasPollTimer = null; } }, 250);
  }
}
