CREATE TABLE hosted_assistant_activity (
 owner TEXT NOT NULL, clientId TEXT NOT NULL, lastSeen INTEGER NOT NULL,
 PRIMARY KEY(owner,clientId)
);
ALTER TABLE hosted_plans ADD COLUMN clientId TEXT;
ALTER TABLE hosted_operations ADD COLUMN clientId TEXT;
