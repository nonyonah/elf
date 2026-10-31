-- Accountless browser authority is independent of assistant and plugin credentials.
CREATE TABLE hosted_browser_sessions (
 tokenHash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE hosted_plugin_consents (
 owner TEXT PRIMARY KEY, connectionId TEXT NOT NULL UNIQUE,
 clientName TEXT NOT NULL, redirectHost TEXT NOT NULL, scopes TEXT NOT NULL,
 expires INTEGER NOT NULL, approvedGeneration TEXT
);
