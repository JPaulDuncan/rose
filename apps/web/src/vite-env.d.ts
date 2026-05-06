/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Idle-logout timeout in minutes. After this much continuous user
   * inactivity (no mouse / keyboard / scroll / touch on the
   * authenticated app, in any tab) the session is logged out and
   * the user is redirected to /login. Default: 5. Set to a number
   * via .env / .env.local at build time.
   */
  readonly VITE_IDLE_TIMEOUT_MINUTES?: string;
  /**
   * Origin of the API server when running `pnpm dev` against a
   * non-default backend. Honoured by vite.config.ts's proxy.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
