import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installApi } from './api.js';
import './styles.css';

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
