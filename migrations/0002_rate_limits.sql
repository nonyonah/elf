-- Fixed-window rate limiting for the token API (60 req/min/token, per CONTRACT.md schema 1).
-- One row per token (scope = token id); reset when the window rolls over.
CREATE TABLE rate_limits (
  scope TEXT PRIMARY KEY,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL
);
