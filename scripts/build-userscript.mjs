// filepath: scripts/build-userscript.mjs
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'src', 'userscript', 'index.js');
const metaPath = path.join(projectRoot, 'src', 'userscript', 'meta.mjs');
const pkgPath = path.join(projectRoot, 'package.json');
const outdir = path.join(projectRoot, 'dist');
const outfile = path.join(outdir, 'tampermonkey-script.js');

async function main() {
  // read version from package.json (semver)
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.version === 'string') version = pkg.version;
  } catch {}

  // import meta builder and generate banner
  let banner;
  try {
    const metaUrl = url.pathToFileURL(metaPath).href;
    const mod = await import(metaUrl);
    const buildMeta = mod.buildMeta;
    banner = typeof buildMeta === 'function' ? buildMeta(version) : '';
  } catch (e) {
    console.error('[build] Failed to load meta builder:', e);
    banner = '';
  }

  const emit = process.argv.includes('--emit');
  if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2018'],
    outfile,
    sourcemap: false,
    minify: false,
    banner: { js: banner ? banner + '\n' : '' },
    legalComments: 'none',
  }).catch((e) => { console.error(e); process.exitCode = 1; });

  if (emit) {
    try {
      const dest = path.join(projectRoot, 'tampermonkey-script.js');
      fs.copyFileSync(outfile, dest);
      console.log(`[build] Emitted bundle to ${path.relative(projectRoot, dest)}`);
    } catch (e) {
      console.error('[build] Failed to emit to root userscript:', e);
    }
  }

  console.log(`[build] Built ${path.relative(projectRoot, outfile)}`);
}

main();
