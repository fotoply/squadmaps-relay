// filepath: src/userscript/main-bootstrap.js
export function bootstrap() {
  // Placeholder bootstrap while migrating code into modules.
  // Move logic from tampermonkey-script.js into modules and call those here.
  if (typeof window !== 'undefined') {
    console.log('[userscript] modular bootstrap ready (no-op)');
  }
}

