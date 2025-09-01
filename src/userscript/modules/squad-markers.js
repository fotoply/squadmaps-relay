// filepath: src/userscript/modules/squad-markers.js
// Squad-specific composite markers module

const TYPES = {
    rally: {
        icon: 'backpack',
        iconOnMap: true,
        color: '#22c55e',
        children: [
            {
                type: "circle",
                radius: 50,
                color: '#22c55e',
                dashArray: '6,6',
                weight: 2,
                fill: false,
                interactive: false
            },
        ],
    },
    fob: {
        icon: 'tent',
        iconOnMap: true,
        color: '#eab308',
        children: [
            {
                type: "circle",
                radius: 150,
                color: '#eab308',
                fillColor: '#eab308',
                fillOpacity: 0.18,
                weight: 1.5,
                interactive: false
            },
            {
                type: "circle",
                radius: 400,
                color: '#eab308',
                dashArray: '6,6',
                weight: 2,
                fill: false,
                interactive: false
            },
        ],
    },
    enemy: {
        icon: 'radio',
        iconOnMap: true,
        color: '#ef4444',
        children: [
            {
                type: "circle",
                radius: 400,
                color: '#ef4444',
                dashArray: '6,6',
                weight: 2,
                interactive: false
            },
        ],
    },
    defend: {
        icon: 'shield-alt',
        iconOnMap: false,
        color: '#22c55e',
        children: [
            {
                type: "square",
                height: 100,
                width: 100,
                color: "#22c55e",
                dashArray: "6,6",
                weight: 2,
                interactive: false,
            },
        ],
    }
};

