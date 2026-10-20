-- Step 4: polling, notifications, activity.
-- drift_runs gains the notify-dedupe fingerprint (elf core driftFingerprint) and
-- the drift verdict of the run, so notifications can compare runs without
-- recomputing anything.
ALTER TABLE drift_runs ADD COLUMN fingerprint TEXT;
ALTER TABLE drift_runs ADD COLUMN driftFound INTEGER;

-- Set when the 15-minute poll sees a newer Figma file version than the last
-- snapshot; cleared when a fresh Figma snapshot lands. readStatus treats
-- "dirty newer than the newest Figma snapshot" as stale.
ALTER TABLE figma_sources ADD COLUMN figmaDirtyAt TEXT;

-- notify jobs carry the built Slack message (elf core buildNotifyMessage), so
-- posting a retry re-posts the exact message the drift run decided on.
ALTER TABLE jobs ADD COLUMN payload TEXT;
