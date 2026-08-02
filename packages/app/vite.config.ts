import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
