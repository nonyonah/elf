/**
 * Auth is delegated to Clerk (hosted): Google OAuth + email code, sessions as
 * JWTs/cookies. The Worker verifies every /api request with @clerk/backend —
 * no auth tables of our own, no client secrets beyond CLERK_SECRET_KEY.
 *
 * Local-first twist: without CLERK_SECRET_KEY the resolver is simply "signed
 * out" (auth-required routes 401), so the worker boots and tests run without
 * any Clerk wiring. Tests inject fake resolvers into `createApp`.
 */
import { createClerkClient } from "@clerk/backend";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env.js";

export interface Session {
  /** Clerk user id (`user_…`) — the identity every workspace-scoped row hangs off. */
  userId: string;
  sessionId?: string;
}

export type SessionResolver = (request: Request, env: Env) => Promise<Session | null>;

export const clerkSessionResolver: SessionResolver = async (request, env) => {
  if (!env.CLERK_SECRET_KEY) return null;
  const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      ...(env.CLERK_PUBLISHABLE_KEY ? { publishableKey: env.CLERK_PUBLISHABLE_KEY } : {}),
    });
    const state = await clerk.authenticateRequest(request, {
      acceptsToken: "session_token",
      ...(authorizedParties?.length ? { authorizedParties } : {}),
    });
    if (!state.isAuthenticated) return null;
    const auth = state.toAuth();
    if (!auth?.userId) return null;
    return { userId: auth.userId, ...(auth.sessionId ? { sessionId: auth.sessionId } : {}) };
  } catch {
    // Malformed, expired or forged tokens are just unauthenticated — never a 500.
    return null;
  }
};

export type AppEnv = { Bindings: Env; Variables: { session: Session } };

export function requireSession(
  resolve: SessionResolver = clerkSessionResolver,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await resolve(c.req.raw, c.env);
    if (!session) {
      return c.json({ error: { code: "unauthorized", message: "Sign in to continue." } }, 401);
    }
    c.set("session", session);
    await next();
  };
}

export function getSession(c: { get: (key: "session") => Session }): Session {
  return c.get("session");
}

/** Best-effort display name for the auto-created workspace; falls back silently. */
export async function workspaceNameFor(env: Env, userId: string): Promise<string> {
  if (!env.CLERK_SECRET_KEY) return "Workspace";
  try {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const user = await clerk.users.getUser(userId);
    const name = user.fullName ?? user.firstName ?? user.username ?? user.primaryEmailAddress?.emailAddress;
    return name?.trim() || "Workspace";
  } catch {
    return "Workspace";
  }
}
