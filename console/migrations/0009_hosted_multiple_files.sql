-- Preserve existing file approvals while allowing additional explicit approvals.
ALTER TABLE hosted_plugin_consents RENAME TO hosted_plugin_consents_old;
CREATE TABLE hosted_plugin_consents (
 owner TEXT NOT NULL, connectionId TEXT NOT NULL UNIQUE,
 clientName TEXT NOT NULL, redirectHost TEXT NOT NULL, scopes TEXT NOT NULL,
 expires INTEGER NOT NULL, approvedGeneration TEXT,
 PRIMARY KEY (owner, connectionId)
);
INSERT INTO hosted_plugin_consents SELECT * FROM hosted_plugin_consents_old;
DROP TABLE hosted_plugin_consents_old;
