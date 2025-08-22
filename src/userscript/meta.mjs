// filepath: src/userscript/meta.mjs
export function buildMeta(version = '0.0.0') {
  return `// ==UserScript==
// @name         Squad Maps sync
// @namespace    http://tampermonkey.net/
// @version      ${version}
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
// @run-at       document-start
// ==/UserScript==
`;
}
