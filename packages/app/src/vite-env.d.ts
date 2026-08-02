/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `tauri` in the desktop build; unset in the hosted one. See main.tsx. */
  readonly VITE_SIMPLEVIS_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite.config.ts from package.json. Shown in the About dialog. */
declare const __APP_VERSION__: string;

interface Window {
  STOATWORKS_ABOUT?: Record<string, string>
}
