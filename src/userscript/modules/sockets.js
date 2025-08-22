// Sockets module: connect to relay and wire events to provided callbacks.
// Usage: const sock = initSocket({ onStateInit, onDrawCreate, onDrawEdit, onDrawDelete, onViewChanged, onPresenceUpdate });
// Returns { emit: { drawCreate, drawEdit, drawDelete, viewChanged, presenceUpdate, usernameSet, drawProgress, mapChanged, pointClicked } }

export function initSocket(deps = {}) {
  const cb = Object.assign({
    onConnected: (_id) => {},
    onStateInit: (_st) => {},
    onDrawCreate: (_shape) => {},
    onDrawEdit: (_shapes) => {},
    onDrawDelete: (_ids) => {},
    onViewChanged: (_view) => {},
    onPresenceUpdate: (_delta) => {},
    onUserJoined: (_u) => {},
    onUserLeft: (_u) => {},
    onUserUpdated: (_u) => {},
    onPointClicked: (_p) => {},
    onMapChanged: (_m) => {},
    onDrawProgress: (_p) => {},
  }, deps || {});

  if (typeof window === 'undefined' || typeof window.io !== 'function') {
    console.warn('[sockets] socket.io not available');
    return { emit: {} };
  }

  const socket = window.io('https://minecraft-alt.fotoply.dev:3000', {
    transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 200
  });

  // Expose ref for diagnostics
  try { window.__squadSocket = socket; } catch (_) {}

  // Incoming
  socket.on('connect', () => { try { cb.onConnected && cb.onConnected(socket.id); } catch (_) {} });
  socket.on('state init', (st) => { try { cb.onStateInit && cb.onStateInit(st); } catch (_) {} });
  socket.on('draw create', (shape) => { try { cb.onDrawCreate && cb.onDrawCreate(shape); } catch (_) {} });
  socket.on('draw edit', (shapes) => { try { cb.onDrawEdit && cb.onDrawEdit(shapes); } catch (_) {} });
  socket.on('draw delete', (ids) => { try { cb.onDrawDelete && cb.onDrawDelete(ids); } catch (_) {} });
  socket.on('view changed', (view) => { try { cb.onViewChanged && cb.onViewChanged(view); } catch (_) {} });
  socket.on('presence update', (delta) => { try { cb.onPresenceUpdate && cb.onPresenceUpdate(delta); } catch (_) {} });
  socket.on('user joined', (u) => { try { cb.onUserJoined && cb.onUserJoined(u); } catch (_) {} });
  socket.on('user left', (u) => { try { cb.onUserLeft && cb.onUserLeft(u); } catch (_) {} });
  socket.on('user updated', (u) => { try { cb.onUserUpdated && cb.onUserUpdated(u); } catch (_) {} });
  socket.on('point clicked', (p) => { try { cb.onPointClicked && cb.onPointClicked(p); } catch (_) {} });
  socket.on('map changed', (m) => { try { cb.onMapChanged && cb.onMapChanged(m); } catch (_) {} });
  socket.on('draw progress', (p) => { try { cb.onDrawProgress && cb.onDrawProgress(p); } catch (_) {} });

  // Outgoing helpers
  const emit = {
    drawCreate: (shape) => { try { socket.emit('draw create', shape); } catch (_) {} },
    drawEdit: (shapes) => { try { socket.emit('draw edit', shapes); } catch (_) {} },
    drawDelete: (ids) => { try { socket.emit('draw delete', ids); } catch (_) {} },
    viewChanged: (view) => { try { socket.emit('view changed', view); } catch (_) {} },
    presenceUpdate: (delta) => { try { socket.emit('presence update', delta); } catch (_) {} },
    usernameSet: (payload) => { try { socket.emit('username set', payload); } catch (_) {} },
    drawProgress: (payload) => { try { socket.emit('draw progress', payload); } catch (_) {} },
    mapChanged: (m) => { try { socket.emit('map changed', m); } catch (_) {} },
    pointClicked: (p) => { try { socket.emit('point clicked', p); } catch (_) {} },
  };

  return { emit, socket };
}

