// filepath: src/userscript/modules/leaflet-events-shim.js
// Leaflet Event shim: intercepts L.Evented.on/off/once (and L.DomEvent.on/off) to expose
// a global, inspectable registry of event handlers for debugging.

let __shimInstalled = false;

function safeWin() {
  try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window; } catch (_) { return window; }
}

function nowTs() { try { return Date.now(); } catch (_) { return 0; } }

function installIfPossible() {
  if (__shimInstalled) return true;
  const W = safeWin();
  const L = (W && W.L) || (typeof window !== 'undefined' && window.L);
  if (!L || !L.Evented) return false;

  try {
    const Reg = new WeakMap(); // target (Evented) -> [ { type, fn, ctx, once, ts } ]
    const DomReg = new WeakMap(); // element (EventTarget) -> [ { type, fn, ctx, ts, capture } ]

    const push = (tgt, entry) => {
      try {
        const arr = Reg.get(tgt) || [];
        arr.push(entry);
        Reg.set(tgt, arr);
      } catch (_) {}
    };
    const remove = (tgt, pred) => {
      try {
        const arr = Reg.get(tgt) || [];
        const keep = arr.filter((e) => { try { return !pred(e); } catch (_) { return true; } });
        Reg.set(tgt, keep);
      } catch (_) {}
    };

    const EP = L.Evented && L.Evented.prototype;
    const origOn = EP && EP.on;
    const origOff = EP && EP.off;
    const origOnce = EP && EP.once;

    if (origOn && !EP.__squadOnPatched) {
      EP.on = function(type, fn, ctx) {
        try {
          if (type && typeof type === 'object') {
            // on({ type1: fn1, type2: fn2 }, ctx)
            const map = type;
            Object.keys(map).forEach((k) => {
              const f = map[k];
              if (typeof f === 'function') push(this, { type: k, fn: f, ctx: ctx || this, once: false, ts: nowTs() });
            });
          } else if (typeof type === 'string' && typeof fn === 'function') {
            type.split(/\s+/).filter(Boolean).forEach((t) => push(this, { type: t, fn, ctx: ctx || this, once: false, ts: nowTs() }));
          }
        } catch (_) {}
        return origOn.apply(this, arguments);
      };
      EP.__squadOnPatched = true;
    }

    if (origOnce && !EP.__squadOncePatched) {
      EP.once = function(type, fn, ctx) {
        try {
          if (typeof type === 'string' && typeof fn === 'function') {
            type.split(/\s+/).filter(Boolean).forEach((t) => push(this, { type: t, fn, ctx: ctx || this, once: true, ts: nowTs() }));
          } else if (type && typeof type === 'object') {
            const map = type;
            Object.keys(map).forEach((k) => {
              const f = map[k];
              if (typeof f === 'function') push(this, { type: k, fn: f, ctx: ctx || this, once: true, ts: nowTs() });
            });
          }
        } catch (_) {}
        return origOnce.apply(this, arguments);
      };
      EP.__squadOncePatched = true;
    }

    if (origOff && !EP.__squadOffPatched) {
      EP.off = function(type, fn, ctx) {
        try {
          if (!type) {
            // off() with no args clears all
            remove(this, () => true);
          } else if (type && typeof type === 'object') {
            const map = type;
            const c = arguments[1];
            Object.keys(map).forEach((k) => {
              const f = map[k];
              remove(this, (e) => e.type === k && (!f || e.fn === f) && (!c || e.ctx === c));
            });
          } else if (typeof type === 'string') {
            const types = type.split(/\s+/).filter(Boolean);
            types.forEach((t) => remove(this, (e) => e.type === t && (!fn || e.fn === fn) && (!ctx || e.ctx === ctx)));
          }
        } catch (_) {}
        return origOff.apply(this, arguments);
      };
      EP.__squadOffPatched = true;
    }

    // Also patch Leaflet's DOM event helper to observe container/document listeners
    try {
      const DE = L.DomEvent;
      if (DE && !DE.__squadPatched) {
        const dOn = DE.on;
        const dOff = DE.off;
        if (typeof dOn === 'function') {
          DE.on = function(obj, types, fn, ctx) {
            try {
              if (obj && typeof fn === 'function' && typeof types === 'string') {
                types.split(/\s+/).filter(Boolean).forEach((t) => {
                  const arr = DomReg.get(obj) || [];
                  arr.push({ type: t, fn, ctx: ctx || obj, ts: nowTs(), capture: false });
                  DomReg.set(obj, arr);
                });
              }
            } catch (_) {}
            return dOn.apply(this, arguments);
          };
        }
        if (typeof dOff === 'function') {
          DE.off = function(obj, types, fn, ctx) {
            try {
              if (!obj) return dOff.apply(this, arguments);
              if (!types) { DomReg.set(obj, []); return dOff.apply(this, arguments); }
              const tlist = typeof types === 'string' ? types.split(/\s+/).filter(Boolean) : [];
              const cur = DomReg.get(obj) || [];
              const kept = cur.filter((e) => {
                const matchType = !tlist.length || tlist.includes(e.type);
                const matchFn = !fn || e.fn === fn;
                const matchCtx = !ctx || e.ctx === ctx;
                return !(matchType && matchFn && matchCtx);
              });
              DomReg.set(obj, kept);
            } catch (_) {}
            return dOff.apply(this, arguments);
          };
        }
        DE.__squadPatched = true;
      }
    } catch (_) {}

    // Expose registries and helpers globally
    try {
      const G = W || window;
      G.__leafletEventRegistry = {
        get(target, type) {
          try {
            const arr = (target && Reg.get(target)) || [];
            if (!type) return arr.slice();
            return arr.filter((e) => e && e.type === type);
          } catch (_) { return []; }
        },
        getAll(type) {
          // WeakMap cannot be iterated; rely on direct reads via of()/ofDeep().
          return [];
        },
        of(target, types) {
          try {
            const tlist = Array.isArray(types) ? types : (types ? [types] : []);
            const res = [];
            if (!target) return res;
            // Prefer registry; fall back to _events if present to also catch pre-shim handlers
            if (target._events) {
              const keys = tlist.length ? tlist : Object.keys(target._events);
              keys.forEach((k) => {
                const hs = (target._events[k] || []);
                hs.forEach((h) => { res.push({ target, type: k, fn: h && (h.fn || h), ctx: h && h.ctx, once: !!(h && h.once), ts: undefined }); });
              });
            }
            const extra = Reg.get(target) || [];
            if (!tlist.length) { extra.forEach((e) => res.push(Object.assign({ target }, e))); }
            else { extra.forEach((e) => { if (tlist.includes(e.type)) res.push(Object.assign({ target }, e)); }); }
            return res;
          } catch (_) { return []; }
        },
        ofDeep(map, types) {
          try {
            const res = [];
            if (!map) return res;
            const tlist = Array.isArray(types) ? types : (types ? [types] : []);
            res.push(...this.of(map, tlist));
            if (typeof map.eachLayer === 'function') {
              map.eachLayer((l) => { try { res.push(...this.of(l, tlist)); } catch (_) {} });
            } else if (map._layers) {
              Object.values(map._layers).forEach((l) => { try { res.push(...this.of(l, tlist)); } catch (_) {} });
            }
            return res;
          } catch (_) { return []; }
        },
        dump(target, types) {
          try { console.log('[LeafletEventRegistry]', this.of(target, types)); } catch (_) {}
        },
        dumpDeep(map, types) {
          try { console.log('[LeafletEventRegistry deep]', this.ofDeep(map, types)); } catch (_) {}
        }
      };

      G.__leafletDomEventRegistry = {
        get(target, type) {
          try {
            const arr = (target && DomReg.get(target)) || [];
            if (!type) return arr.slice();
            return arr.filter((e) => e && e.type === type);
          } catch (_) { return []; }
        },
        dump(target, type) {
          try { console.log('[LeafletDomEventRegistry]', this.get(target, type)); } catch (_) {}
        }
      };

      // Convenience helpers mirroring earlier console snippets
      G.__leafletListHandlers = function(obj, types) { try { return G.__leafletEventRegistry.of(obj, types); } catch (_) { return []; } };
      G.__leafletListHandlersDeep = function(map, types) { try { return G.__leafletEventRegistry.ofDeep(map, types); } catch (_) { return []; } };
    } catch (_) {}

    __shimInstalled = true;
    return true;
  } catch (_) { return false; }
}

export function initLeafletEventsShim() {
  // Install immediately if possible; otherwise poll briefly.
  if (installIfPossible()) return;
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (installIfPossible()) { clearInterval(t); }
    if (tries > 120) { clearInterval(t); }
  }, 250);
}

