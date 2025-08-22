// filepath: src/userscript/utils.js
// Small shared helpers used across modules

export function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function waitForLeaflet() {
  return !!(typeof window !== 'undefined' && window.L && L.Map && L.CircleMarker);
}

export function ensureFontAwesomeOnce() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('squadmaps-fa')) return;
  const link = document.createElement('link');
  link.id = 'squadmaps-fa';
  link.rel = 'stylesheet';
  link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  document.head.appendChild(link);
}

export function ensureStyleOnce(id, css) {
  if (typeof document === 'undefined') return;
  let st = document.getElementById(id);
  if (!st) {
    st = document.createElement('style');
    st.id = id;
    document.head.appendChild(st);
  }
  if (st.textContent !== css) st.textContent = css;
}

