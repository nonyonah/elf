-- One browser may explicitly authorize several assistants without replacing access.
ALTER TABLE hosted_browser_sessions RENAME TO hosted_browser_sessions_old;
CREATE TABLE hosted_browser_sessions (
 tokenHash TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL,
 PRIMARY KEY (tokenHash, owner)
);
INSERT INTO hosted_browser_sessions SELECT * FROM hosted_browser_sessions_old;
DROP TABLE hosted_browser_sessions_old;
