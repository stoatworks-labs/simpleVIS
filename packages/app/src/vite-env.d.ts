/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `tauri` in the desktop build; unset in the hosted one. See main.tsx. */
  readonly VITE_SIMPLEVIS_BACKEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
