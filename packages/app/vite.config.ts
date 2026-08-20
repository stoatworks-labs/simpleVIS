import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { readFileSync } from 'node:fs';

// The ROOT package.json, not this workspace's: the release tag follows the root
// version, and a workspace copy drifts behind it silently (atem-overseer's had).
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * The support footer, appended to the hosted build only.
 *
 * index.html is shared by both targets, so a tag written into the markup would
 * ship the funding footer inside the Tauri app as well — asking a user who has
 * already installed the desktop build for money, in a window that cannot open
 * the links usefully. The `tauri` mode is the one Tauri builds through
 * (see beforeBuildCommand in src-tauri/tauri.conf.json), so everything else is
 * the Worker build.
 *
 * data-hosted goes on <html> for the same reason: styles.css locks the viewport
 * with `height: 100%` plus `overflow: hidden`, which leaves a footer appended
 * after #root unreachable, and that lock must stay for the desktop window.
 */
function supportFooter(mode: string): Plugin {
  return {
    name: 'stoatworks-support-footer',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (mode === 'tauri') return html;
        return {
          html: html.replace('<html lang="en">', '<html lang="en" data-hosted>'),
          tags: [
            {
              tag: 'script',
              injectTo: 'body',
              attrs: {
                src: '/support-footer.js',
                defer: true,
                'data-app': 'simpleVIS',
                'data-repo': 'https://github.com/stoatworks-labs/simpleVIS',
                'data-version': `v${pkg.version}`,
                'data-note':
                  'It runs entirely in your browser — no account, and no rig you import is uploaded.',
              },
            },
          ],
        };
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react(), supportFooter(mode)],
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
}));
