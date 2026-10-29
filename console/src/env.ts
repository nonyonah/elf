/** Worker bindings and secrets. Secrets arrive via `wrangler secret put` / `.dev.vars` — never from the repo. */
export interface Env {
  /** Hosted MCP stays disabled until OAuth storage and acceptance checks are ready. */
  HOSTED_MCP_ENABLED?: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
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

  /**
   * Public origin of the console (e.g. https://console.elf.dev). Slack
   * messages link back here; when unset, links are simply omitted.
   */
  CONSOLE_ORIGIN?: string;

  /** Slack app OAuth credentials — "Add to Slack" installs an incoming webhook. */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  FIGMA_CLIENT_ID?: string;
  FIGMA_CLIENT_SECRET?: string;

  /**
   * Local preview only. With no CLERK_SECRET_KEY configured, this var stands
   * in for a signed-in user (e.g. `user_dev_preview`) so the console can be
   * exercised without a Clerk instance. Never set in production.
   */
  DEV_ONLY_FAKE_USER?: string;
}
