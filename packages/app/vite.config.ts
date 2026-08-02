import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { readFileSync } from 'node:fs';

// The ROOT package.json, not this workspace's: the release tag follows the root
// version, and a workspace copy drifts behind it silently (atem-overseer's had).
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  // Both targets serve from the root: the Cloudflare Worker has its own
  // hostname, and Tauri loads from a file-ish origin. A /repo/ base path would
  // break both.
  base: './',
  build: {
    outDir: 'dist',
    // three.js is most of the bundle and is genuinely needed on first paint,
    // so warning about it every build is noise.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5219,
    strictPort: true,
  },
});
