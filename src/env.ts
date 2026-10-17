/** Worker bindings and secrets. Secrets arrive via `wrangler secret put` / `.dev.vars` — never from the repo. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  /** Clerk secret key (`sk_…`) — verifies session tokens. Optional locally: without it, requests are signed out. */
  CLERK_SECRET_KEY?: string;
  /** Clerk publishable key (`pk_…`) — public by design; echoed into auth metadata. */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Comma-separated origins allowed to send Clerk session tokens (CSRF hardening). */
  CLERK_AUTHORIZED_PARTIES?: string;

  /** Base64-encoded 32-byte AES-GCM key for connection secrets (write-only at rest). */
  SECRETS_KEY?: string;
}
