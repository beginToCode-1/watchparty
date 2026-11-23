/// <reference types="vite/client" />
/// <reference types="@crxjs/vite-plugin/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  readonly VITE_WEB_URL: string;
}

/** Double-injection guard: `executeScript` may run on a tab that already has the static content script. */
declare var __wpLoaded: boolean | undefined;
