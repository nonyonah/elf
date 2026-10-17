/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** "1" renders the console without Clerk against the worker's DEV_ONLY_FAKE_USER bypass. */
  readonly VITE_DEV_SESSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
