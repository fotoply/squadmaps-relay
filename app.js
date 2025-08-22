const express = require('express');
const {createServer} = require('node:https');
const {join} = require('node:path');
const {Server} = require('socket.io');
const fs = require('fs');

const privateKey = fs.readFileSync('/etc/letsencrypt/live/minecraft-alt.fotoply.dev/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/minecraft-alt.fotoply.dev/fullchain.pem', 'utf8');

const credentials = {key: privateKey, cert: certificate};
const app = express();
const server = createServer(credentials, app);
const io = new Server(server);

// In-memory state
let currentMap = null; // string path (pathname+search)
let clickHistory = []; // array of latlng objects
const MAX_HISTORY = 500; // cap to prevent unbounded growth
let drawings = {}; // id -> shape { id, geojson }
let currentView = null; // { center: {lat, lng}, zoom }
let users = {}; // socketId -> { id, name, tool, cursor, view, color }

app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'client.html'));
});

app.get('/tampermonkey-script.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(join(__dirname, 'tampermonkey-script.js'));
});

io.on('connection', (socket) => {
    console.log('a user connected');
    // Register user
    users[socket.id] = { id: socket.id, name: null, tool: null, cursor: null, view: null, color: null };
    // Send current state to the newly connected client (always send presence snapshot)
    socket.emit('state init', {
        currentMap,
        clicks: clickHistory,
        drawings: Object.values(drawings),
        view: currentView,
        users: Object.values(users)
    });
    // Inform others a user joined (anonymous until named)
    socket.broadcast.emit('user joined', { id: socket.id });

    socket.on('disconnect', () => {
        console.log('user disconnected');
        // Cleanup presence and notify others
        delete users[socket.id];
        socket.broadcast.emit('user left', { id: socket.id });
    });

    socket.on('point clicked', (msg) => {
        console.log("Point clicked:", msg);
        // Record to history (lat/lng object)
        clickHistory.push(msg);
        if (clickHistory.length > MAX_HISTORY) {
            clickHistory = clickHistory.slice(-MAX_HISTORY);
        }
        socket.broadcast.emit('point clicked', msg);
    });

    socket.on('map changed', (msg) => {
        console.log("Map changed received:", msg);
        if (msg === currentMap) {
            console.log('Map unchanged, preserving click history');
            // Optionally refresh sender with current state (in case it emitted because it lacked it)
            socket.emit('state init', {currentMap, clicks: clickHistory});
            return; // do not clear or broadcast
        }
        currentMap = msg;
        clickHistory = [];
        drawings = {}; // reset drawings on map change
        socket.broadcast.emit('map changed', msg);
    });

    socket.on('draw create', (shape) => {
        if (!shape?.id || !shape?.geojson) return;
        drawings[shape.id] = shape;
        socket.broadcast.emit('draw create', shape);
    });

    socket.on('draw edit', (shapes) => {
        if (!Array.isArray(shapes)) return;
        shapes.forEach(s => {
            if (s?.id && s?.geojson && drawings[s.id]) drawings[s.id] = s;
        });
        socket.broadcast.emit('draw edit', shapes);
    });

    socket.on('draw delete', (ids) => {
        if (!Array.isArray(ids)) return;
        ids.forEach(id => {
            delete drawings[id];
        });
        socket.broadcast.emit('draw delete', ids);
    });

    // Relay map view changes (center/zoom)
    socket.on('view changed', (view) => {
        try {
            if (!view || typeof view.zoom !== 'number' || !view.center) return;
            const {lat, lng} = view.center;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            // Save and broadcast to others
            currentView = { center: { lat, lng }, zoom: view.zoom };
            socket.broadcast.emit('view changed', currentView);
        } catch (e) {
            console.warn('Invalid view payload', e, view);
        }
    });

    // Presence: username set
    socket.on('username set', (payload) => {
        try {
            const nameRaw = (payload && payload.name) || '';
            const name = String(nameRaw).trim().slice(0, 32);
            if (!users[socket.id]) users[socket.id] = { id: socket.id };
            users[socket.id].name = name || null;
            socket.broadcast.emit('user updated', { id: socket.id, name: users[socket.id].name });
            // Also acknowledge to sender with canonical value
            socket.emit('user updated', { id: socket.id, name: users[socket.id].name });
        } catch (e) {
            console.warn('username set error', e);
        }
    });

    // Presence: cursor/tool/color/view updates
    socket.on('presence update', (payload) => {
        try {
            if (!payload || typeof payload !== 'object') return;
            const u = users[socket.id] || (users[socket.id] = { id: socket.id });
            if (payload.tool !== undefined) u.tool = typeof payload.tool === 'string' ? payload.tool.slice(0, 24) : null;
            if (payload.cursor && Number.isFinite(payload.cursor.lat) && Number.isFinite(payload.cursor.lng)) {
                u.cursor = { lat: payload.cursor.lat, lng: payload.cursor.lng };
            }
            if (payload.view && payload.view.center && Number.isFinite(payload.view.center.lat) && Number.isFinite(payload.view.center.lng) && Number.isFinite(payload.view.zoom)) {
                u.view = { center: { lat: payload.view.center.lat, lng: payload.view.center.lng }, zoom: payload.view.zoom };
            }
            if (payload.color && typeof payload.color === 'string') {
                const m = String(payload.color).trim();
                if (/^#?[0-9a-fA-F]{6}$/.test(m)) {
                    u.color = (m[0] === '#' ? m : ('#' + m)).toLowerCase();
                }
            }
            // Broadcast minimal delta to others (include only fields that changed)
            const delta = { id: socket.id };
            if ('tool' in payload) delta.tool = u.tool;
            if (payload.cursor) delta.cursor = u.cursor;
            if (payload.view) delta.view = u.view;
            if (payload.color) delta.color = u.color;
            socket.broadcast.emit('presence update', delta);
        } catch (e) {
            console.warn('presence update error', e);
        }
    });

    // NEW: relay in-progress drawing updates (not persisted)
    socket.on('draw progress', (payload) => {
        try {
            if (!payload || typeof payload !== 'object') return;
            const { id, shapeType, points } = payload;
            if (!id) return;
            // Allow polyline, polygon, rectangle, circle
            if (shapeType !== 'polyline' && shapeType !== 'polygon' && shapeType !== 'rectangle' && shapeType !== 'circle') return;
            if (!Array.isArray(points) || points.length === 0) {
                // Allow empty + end flag to signal cancellation/clear
                if (!payload.end) {
                    // For circle progress we allow center/radius without points
                    if (shapeType !== 'circle') return;
                }
            }
            socket.broadcast.emit('draw progress', payload);
        } catch (e) {
            console.warn('draw progress error', e);
        }
    });
});

server.listen(3000, () => {
    console.log('server running at https://minecraft-alt.fotoply.dev:3000');
});