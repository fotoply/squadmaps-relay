// filepath: src/userscript/index.js
/*
Entry point for the modular Tampermonkey userscript build.
Gradually migrate code from tampermonkey-script.js into modules imported here.
*/
import { bootstrap } from './main-bootstrap.js';

(function(){
  try {
    bootstrap();
  } catch (e) {
    // keep userscript resilient in case of partial migration
    console.warn('[userscript] bootstrap failed', e);
  }
})();

