// Build only the real components used by the targeted browser check.
// node scripts/viewer-refresh-build.mjs && python scripts/viewer-refresh-browser.py tmp/viewer-refresh/fixture.js
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const webRequire = createRequire(resolve('web/package.json'));
const { build } = createRequire(webRequire.resolve('vite'))('esbuild');
await build({ entryPoints: ['scripts/viewer-refresh-fixture.tsx'], bundle: true,
  outfile: 'tmp/viewer-refresh/fixture.js', platform: 'browser', format: 'iife',
  jsx: 'automatic', nodePaths: [resolve('web/node_modules')], define: { 'process.env.NODE_ENV': '"test"' } });
