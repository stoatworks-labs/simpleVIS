import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installApi } from './api.js';
import { routeExternalLinksToBrowser } from './lib/externalLinks.js';
import './styles.css';

// The About dialog's data file ships a version baked at sync time; this is the
// one the build actually produced. Spread, not assign: about-data.js may not
// have run yet, and it merges rather than overwriting. See public/about.js.
window.STOATWORKS_ABOUT = { ...window.STOATWORKS_ABOUT, version: __APP_VERSION__ };

// Tauri's webview silently refuses target="_blank". Every link in the About
// dialog is external, so without this the desktop build looks broken while the
// hosted build is fine — the worst way for it to fail.
routeExternalLinksToBrowser();

/**
 * Choose the backend before the app mounts.
 *
 * `VITE_SIMPLEVIS_BACKEND` is set to `tauri` by the desktop build only, so the
 * import below is statically eliminated from the hosted bundle — the browser
 * build ships no Tauri client code at all, and nothing at runtime ever asks
 * which environment it is in.
 */
async function bootstrap() {
  if (import.meta.env.VITE_SIMPLEVIS_BACKEND === 'tauri') {
    const { tauriApi } = await import('./backend-tauri.js');
    installApi(tauriApi);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('no #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
