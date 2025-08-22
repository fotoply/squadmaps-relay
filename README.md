# SquadMaps Relay + Tampermonkey Sync Script

A collaborative synchronization layer for https://squadmaps.com enabling real‑time shared navigation and drawing between
multiple browsers. It consists of a lightweight Socket.IO relay server and a Tampermonkey userscript that augments (and
partially polyfills) Leaflet + Leaflet.Draw on the live site.

## Core Features

- Map URL sync (path + query) across clients (pushState / replaceState / popstate and polling fallback).
- Marker click broadcasting (hooks existing CircleMarkers, replays on late join).
- Collaborative drawing (create / edit / delete) for: polygons, polylines, rectangles, circles, markers.
- Robust shape serialization (custom GeoJSON properties: shapeType, color, radius) and deserialization with editing
  enablement for remote layers.
- Per‑user color selection with recent color palette (persisted) + live option patching of Leaflet.Draw handlers.
- Continuous drawing mode (re‑activates last tool after finishing a shape) with session safeguards.
- Right‑click finish / cancel for native polyline & polygon tools.
- Right‑click cancellation for rectangle/circle before drag start.
- Global permanent suppression of browser context menu inside the map container (user preference).
- Duplicate create suppression via last GeoJSON signature check.
- Remote shapes become editable (manual attachment of L.Edit.* editors when needed).
- Delete mode enhancements: styling (dashed) + fallback click‑to‑remove hit detection if plugin removal misses.
- Larger, styled edit vertices for easier manipulation.
- Pointer‑event blocker mitigation: temporarily disables obstructing panes (canvas / overlays) during drawing & editing.
- Resilient re‑initialization after map swaps (new Leaflet map instance or toolbar loss triggers re‑setup).
- Real‑time presence: usernames, live cursors, and selected tool badges; follow another user’s view via a user list.

## Presence UI (usernames, cursors, follow)

- A small “Users” panel appears in the top‑right.
- Enter your display name; it’s broadcast to others (trimmed, max 32 chars).
- The list shows all other users with a color swatch, name, and current tool.
- Select a radio next to a user to “follow” them: your map centers/zooms to their shared view; if no view yet, it
  centers to their live cursor until a view arrives. The selection persists via localStorage key `squadmapsFollowUser`.
- Your cursor position is sent at a low rate (throttled) while moving the mouse over the map. Your tool and map view
  changes are also broadcast.

## Recent Refinements

1. Early (pointerdown) right‑click interception prevents insertion of spurious final vertices.
2. Unified __squadHandleRCFinish logic and earlyRC path reduce race conditions with Leaflet.Draw internals.
3. Permanent context menu disable inside map (simplified UX as requested).
4. Rebuild logic for drawing toolbar after navigation or site re‑render (detects new map object, missing toolbar DOM, or
   changed featureGroup parent).
5. Continuous mode guarded against accidental re‑arming after manual cancel / tool switch.
6. Circle interactivity forced (ensures events propagate under Canvas renderer).
7. Legacy marker picker button removed; a single radial marker selector opens after placing a marker.
8. Radial menu is now positioned relative to the map container and centered on the newly created marker; it closes on
   Esc, outside click, or map move/zoom.
9. Choosing an icon in the radial updates the current marker and patches Leaflet.Draw options so future marker
   placements use the same icon; continuous mode resumes only after the radial closes.
10. Added real‑time presence: username input, user list with follow‑view, remote cursors, and tool status broadcasting.
11. In‑game units formatter: distances and areas shown by Leaflet.Draw are scaled using a per‑map factor you can tweak
    via `window.setInGameUnitsScale(k)`.
12. Rectangle dimensions: while drawing a rectangle, the draw tooltip appends Width and Height on separate lines using
    scale‑corrected units.
13. Fixed polygon/rectangle area accuracy: compute area in the map’s CRS using `crs.project` (planar units²), then apply
    the in‑game scale (k²). This removes the ~25% inflation and aligns area with distance scaling.

## Architecture

- **Server (app.js)**: Express + Socket.IO; acts as stateful relay: tracks current map, last clicks, drawing state, and
  simple presence (name/tool/cursor/view). Emits deltas to all other clients.
- **Client test page (client.html)**: Simple Socket.IO connectivity check (optional).
- **Userscript (tampermonkey-script.js)**: Injected on squadmaps.com; loads Leaflet.Draw (if absent), captures the map
  instance, manages collaborative layers, presence UI, and real‑time socket events.

### Key Internal Structures

- `drawnItems`: L.FeatureGroup shared for all synced layers.
- `layerIdMap`: id → Leaflet layer mapping.
- `presenceUsers`: socketId → { id, name, tool, cursor, view } on the client.
- `__squadActiveDrawHandler`: currently active Leaflet.Draw handler (monkey‑patched enable/disable to track).
- Continuous mode session tracking: `currentDrawSessionId`, `currentDrawCreationOccurred`, `continuousActiveType`.

### Event Flow (Socket.IO)

Client emits / listens for:

- `map changed` (string path)
- `point clicked` (LatLng payload)
- `draw create` ({ id, geojson })
- `draw edit` ([{ id, geojson }, ...])
- `draw delete` ([id, ...])
- `state init` (server → client initial snapshot)
- `username set` (name string) and `user updated` (server → others)
- `presence update` (tool/cursor/view deltas)

## Style notes

The project tries to leave only comments when they explain extra behavior that may not be obvious from the code.

The code is formatted with ample spacing and indentation to improve readability, especially for the
userscript that is injected into the page and may be read by users.

This means new lines are used to separate logical blocks, curly braces are used even for one‑line statements, and
long lines are split into multiple lines for clarity wherever possible.

This also means that code is not moved around unless it is necessary to do so, e.g. when a function is moved
to a different file or when a function is split into multiple smaller functions, as this would make the code harder to
read
and understand when differences are shown in a code review or when looking at the code history.

## Shape Serialization

Each shape serialized to GeoJSON with added properties:

- `shapeType`: polygon | polyline | rectangle | circle | marker
- `color`: stroke/fill base color
- `radius`: (circle only)
  Circles represented as Point + radius property for cross‑compat and minimal payload.

## Right‑Click Behavior Summary

| Tool      | 0 pts  | < needed & >0 | ≥ needed | Drag shape not started | Drag shape started |
|-----------|--------|---------------|----------|------------------------|--------------------|
| Polyline  | Cancel | Cancel        | Finish   | n/a                    | n/a                |
| Polygon   | Cancel | Cancel        | Finish   | n/a                    | n/a                |
| Rectangle | n/a    | n/a           | n/a      | Cancel (no shape)      | Suppress menu      |
| Circle    | n/a    | n/a           | n/a      | Cancel (no shape)      | Suppress menu      |

## Installation (Server)

1. Install dependencies: `npm install` (Socket.IO, Express implied by package.json).
2. Run: `node app.js` (defaults to configured port, e.g. 3000).
3. Ensure public endpoint (e.g. `https://your-domain:3000`).
4. Update userscript @updateURL / @downloadURL if serving from custom domain.

These steps should ONLY be performed by a human, not automatically.


## Modular userscript build (scaffolding)

A modular authoring setup has been added so you can split the userscript into small modules while still producing one file for Tampermonkey.

- Author code under: src/userscript/
    - meta.mjs: exports the @UserScript header banner (preserved).
    - index.js: entry point calling your bootstrap.
    - main-bootstrap.js: place imports and initialization here as you migrate.
- Bundle to dist/tampermonkey-script.js:

```bash
npm install
npm run build:userscript
```

- To also overwrite the root tampermonkey-script.js (served by your server):

```bash
npm run build:userscript:emit
```

### Installation (Userscript)

1. Install Tampermonkey (or similar manager).
2. Add the `tampermonkey-script.js` (served by your domain or local deployment).
3. Open `https://squadmaps.com` in multiple browsers; drawings & navigations sync.

## Operational Notes

- If a client arrives late, it receives `state init` with existing drawings + last map URL and pending marker clicks.
- Map changes suppressed briefly after programmatic navigation to avoid loops (`suppressNextMapEmit`).
- Duplicate shape create prevention uses cached last serialized GeoJSON string.

## Customization

- Toggle continuous mode via ∞ button (persists in localStorage key `squadmapsContinuousMode`).
- Toggle verbose logging in console: `window.__squadDrawVerbose = true`.
- Retrieve debug snapshot: `window.__squadDrawDebugInfo()`.

## Security / Trust

This userscript injects external Leaflet.Draw assets from unpkg. For a locked environment, self‑host the assets and
adjust URLs to prevent supply chain risk.

## TODO

In order of priority:

- [x] Fix background colors on toolbar to be more readable (darkened to #171718 base with clearer hover/active states).
- [x] Fix toolbar having weird black outlines that extend to the width of the color picker
- [x] Make the continuous mode button text bigger (replaced with Font Awesome infinity icon at 15px).
- [x] Fix markers tool, e.g. currently it points to invalid image, add support for a couple of different marker types
  with
  images/icons, maybe with a circle menu when placing a marker.
- [x] Add a way to sync the current map view (zoom, center) across clients.
- [x] Username input field for collaborative context. Should live show other users cursor position and selected
  drawing tool, as well as a small list in the corner with the names of all users currently connected to the map. The
  list should have a radio button next to each user to select them, and if a user is selected then your view should be
  synchronized to theis.
- [ ] Make polygon and poly-lines sync as they are being drawn, not only when finished. (multiple attempts have been made, all failed, some leftover code is still in the script)
- [x] Update the text when drawing on the map to use in-game length units (e.g. meters, kilometers, etc.) instead of
  Leaflet's default units, and make them actually reflect the in-game units, e.g. when drawing a polygon it should
  show the perimeter and area in in-game units, and when drawing a polyline it should show the length in in-game units.
  Maybe need to look at how the grid system works in SquadMaps to get the correct units.
- [ ] Undo/redo with ctrl+z / ctrl+y support.
- [ ] Better state synchronization when joining mid-session, currently it relies on clicking ALL the points to resync
  the
  state, which is not very user-friendly and can be slow. Maybe find a way to only sync the current chain of points
  or a way to modify the internal state of the squad maps client to match the server state.
- [ ] Figure out why sometimes when a point is click it treats it as the second point when its actually the first point
  in
  the current lane. This only happens when a point CAN be both the first and second point in the current lane, e.g. when
  clicking a point that is already in the lane or when all lanes are still possible.
- [ ] Mortar synchronization: when a mortar is placed, it should be synced across clients, but with each client having
  its
  own mortar marker that can be moved around. All clients should share point target points, but each client should be
  able to see their own data for the target marker.
- [ ] Reorganize and cleanup the code, it is a bit messy and could use some refactoring.
- [ ] Add a way to detect when hooking into the Leaflet map fails, this usually happens on initial page load when the
  map is not yet available, and the script tries to hook into it too early. Maybe add a retry mechanism that waits for
  the map to be available before hooking into it.

## Future Ideas

- Per‑shape metadata annotations / labels.
- Role / permission layers (view vs edit).
- Bandwidth optimization (delta updates for edits).
- Firefox supports (currently not sure what breaks, no errors in console, but the script does not work).

## Versioning

- The userscript @version is injected from package.json (semver).
- To bump the userscript version:
  - Edit "version" in package.json or run `npm version <new-version>`.
  - Rebuild: `npm run build:userscript` (and `:emit` if you want to overwrite the root userscript).

---
MIT License.