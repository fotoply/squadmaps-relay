# SquadMaps Relay + Tampermonkey Sync Script

Real‑time collaboration for https://squadmaps.com: a small Socket.IO relay server plus a modular Tampermonkey userscript
that syncs map navigation, drawings, pointer pings, and presence across browsers.

## What’s included

- Relay server (Express + Socket.IO) with in‑memory state
- Modular userscript (esbuild bundle) injected on squadmaps.com
- Basic test page (client.html) that iframes squadmaps.com

## Core features

- Map URL sync: emits and applies SPA URL changes (pushState/replaceState/popstate) so everyone stays on the same map
  path.
- Marker click sync: hooks existing CircleMarker clicks and replays them for late joiners with visual “ping”.
  Ctrl/Meta‑click anywhere to broadcast a ping.
- Drawing sync: create/edit/delete for polyline, polygon, rectangle, circle, and marker.
- In‑progress draw preview: live “ghost” progress for remote shapes while a teammate is drawing (
  polyline/polygon/rectangle/circle).
- Robust shape serialization: GeoJSON + properties (shapeType, style, radius, marker icon name/color) and safe
  deserialization.
- View sync: one‑click “Sync View” button broadcasts current center/zoom; presence “follow” keeps you on a user’s shared
  view.
- Presence: usernames, live cursors, and tool badges; radio list to follow another user’s view.
- Drawing UX extras: color picker with recent colors, continuous mode toggle (∞), larger edit vertices, right‑click
  finish/cancel for draws, and toolbar CSS fixes.

## Architecture at a glance

- Server (app.js)
    - HTTPS Express server + Socket.IO
    - Tracks: currentMap (path), clickHistory (last N pings), drawings (id→feature), currentView, users (presence)
    - Relays: map/view/points/draw events; persists drawings and view across clients
- Userscript (src/userscript/** → dist/tampermonkey-script.js)
    - Captures the Leaflet map, ensures Leaflet.Draw assets, attaches a shared FeatureGroup, wires UI and sockets

## Userscript modules

- `modules/sockets.js`: `initSocket(deps)` connects to the relay and exposes `emit` helpers; raw socket at
  `window.__squadSocket`.
- `modules/draw.js`: `initDraw({ emit })` sets up Leaflet.Draw, serializes layers, emits
  `drawCreate/Edit/Delete/Progress`, and applies remote changes.
- `modules/view-sync.js`: `initViewSync({ emit })` adds a “Sync View” button and exposes
  `applyRemoteViewIfPossible(view)` and `isApplying()`.
- `modules/presence.js`: `initPresence({ applyRemoteView, isApplying })` renders the presence panel, live cursors, and
  follow. Wire emitters via `presence.setEmit({ presenceUpdate, usernameSet })`.
- `modules/points.js`: hooks CircleMarker clicks and Ctrl/Meta map clicks; replays remote pings with cadence to avoid
  races.
- `modules/markers.js`: Font Awesome marker icon choice (radial picker after placing a marker) and patches the Marker
  draw tool icon.
- `modules/toolbar-extras.js`: color picker (with recent colors) and continuous drawing toggle.
- `rightclick.js`: suppresses context menu in the map and finishes/cancels active draws safely.

Notes

- The first Leaflet map instance is captured to `window.squadMap` for downstream modules.
- Incoming drawings from `state init` are buffered until the map is ready, then applied.

## Socket.IO events

Client → server

- `map changed` string path (e.g. /map?name=…)
- `point clicked` { lat, lng, color? }
- `view changed` { center:{lat,lng}, zoom }
- `draw create` { id, geojson }
- `draw edit` [ { id, geojson }, … ]
- `draw delete` [ id, … ]
- `draw progress` { id, shapeType, points[] | center/radius, end? }
- `username set` { name }
- `presence update` deltas { tool?, cursor?, view?, color? }

Server → client

- `state init` { currentMap, clicks, drawings[], view, users[] }
- `map changed` string path
- `point clicked` { lat, lng, color? }
- `view changed` { center, zoom }
- `draw create` / `draw edit` / `draw delete`
- `draw progress`
- `user joined` / `user left` / `user updated`
- `presence update` deltas

## Shape serialization

Each synced layer becomes GeoJSON plus properties:

- `shapeType`: polygon | polyline | rectangle | circle | marker
- `style`: { color, weight, opacity, fillColor, fillOpacity }
- `radius`: circle only
- `icon` and `iconColor`: marker only (Font Awesome name and color)

## Right‑click behavior (summary)

- Polyline/Polygon: finish if enough points, otherwise cancel; suppresses native context menu.
- Rectangle/Circle: cancel before drag starts; suppresses native context menu while dragging.
- Marker: cancel active marker tool.

## Build the userscript

Author under `src/userscript/`, then bundle to `dist/tampermonkey-script.js`.

```bash
npm install
npm run build:userscript
# optionally also emit to project root as tampermonkey-script.js (served by the server)
npm run build:userscript:emit
```

## Deploy and configure

- Server runs on port 3000 and uses HTTPS in app.js. TLS key/cert paths are currently set for a Let’s Encrypt deploy;
  adjust for your host or change to HTTP for local testing.
- The userscript connects to `https://minecraft-alt.fotoply.dev:3000` and the @connect/@updateURL/@downloadURL in
  meta.mjs reference the same host. If you self‑host, update:
    - `src/userscript/modules/sockets.js` (socket URL)
    - `src/userscript/meta.mjs` (@connect, @updateURL, @downloadURL)
- Test page: open `client.html` if you want a simple iframe wrapper of squadmaps.com.

## Installation (userscript)

1. Install Tampermonkey.
2. Install the built `tampermonkey-script.js` from your host.
3. Visit https://squadmaps.com and open a map; your session will sync with others connected to the same relay.

## Operational notes

- Late joiners receive `state init` with drawings, last pings, current view, and presence snapshot.
- URL loop prevention: a short suppression window avoids echoing map changes after programmatic navigation.
- The draw toolbar is re‑ensured after SPA map swaps and DOM mutations.

## TODO / ideas

- [x] In‑progress polyline/polygon/rectangle/circle sync while drawing (draw progress).
- [x] Sync current map view (toolbar button) and presence follow.
- [x] Fix toolbar blocking clicks and improve readability; larger edit vertices.
- [x] Font Awesome marker icons with radial picker; remember choice.
- [x] Undo/redo (Ctrl+Z / Ctrl+Y).
- [x] Add quick delete/edit for shapes
- [ ] Edit sync in progress (move vertices, move entire shape), not just on edit end.
- [ ] Mortar workflow: shared targets with per‑client movable local marker.
- [ ] Squad specific features: spawn points, rally points, FOBs, etc. with a corresponding radius that is pre-scaled.
  Should be one-element, so if you move or delete the flag the radius goes with it. They should also have a fixed color
  based on type (e.g. spawn = green, rally = blue, FOB = yellow/dashed). <- New module
- [ ] Better late‑join performance for very large sessions (delta edits, paging).
- [ ] Additional robustness for initial Leaflet hook on very slow loads.
- [ ] Server selection which uses a handshake to verify that the relay is reachable before switching.
- [ ] Multi-room support, only emit events to others in the same room, including map change and state init. By default
  everyone is in the same room.

## Versioning

- The userscript @version is injected from package.json (semver). Bump package.json and rebuild when you ship.

---
MIT License.
