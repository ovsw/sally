/**
 * The database as it stood before the import: the schema after the first ten
 * migrations, as SQLite recorded it. It must not change; the migration test
 * builds a database from it.
 */
export const PREVIOUS_SCHEMA_VERSION = 10;

export const PREVIOUS_SCHEMA = `
CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    check_type  TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    created_at  TEXT NOT NULL
  , switched_off INTEGER NOT NULL DEFAULT 0 CHECK (switched_off IN (0, 1)));
CREATE TABLE versions (
    id            INTEGER PRIMARY KEY,
    rule_id       INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    number        INTEGER,
    instruction   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    published_at  TEXT, name TEXT NOT NULL DEFAULT '', all_projects INTEGER NOT NULL DEFAULT 1 CHECK (all_projects IN (0, 1)), check_type TEXT NOT NULL DEFAULT 'message'
    CHECK (check_type IN ('message', 'reply')),
    UNIQUE (rule_id, number)
  );
CREATE UNIQUE INDEX one_draft_per_rule ON versions (rule_id) WHERE number IS NULL;
CREATE TABLE conditions (
    id          INTEGER PRIMARY KEY,
    version_id  INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    text        TEXT NOT NULL
  );
CREATE TABLE checks (
    id            INTEGER PRIMARY KEY,
    created_at    TEXT NOT NULL,
    session_id    TEXT,
    cwd           TEXT,
    check_type    TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    text          TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL,
    input_tokens  INTEGER,
    cutoff        REAL NOT NULL,
    outcome       TEXT NOT NULL
                  CHECK (outcome IN ('nothing', 'attached', 'sent_back', 'skipped', 'failed')),
    error         TEXT
  , project_id INTEGER REFERENCES projects (id), cut INTEGER NOT NULL DEFAULT 0 CHECK (cut IN (0, 1)), request_tokens INTEGER);
CREATE TABLE scores (
    check_id      INTEGER NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    rule_id       INTEGER NOT NULL,
    version_id    INTEGER NOT NULL,
    condition_id  INTEGER NOT NULL,
    score         REAL NOT NULL
  );
CREATE INDEX scores_by_check ON scores (check_id);
CREATE INDEX scores_by_version ON scores (version_id);
CREATE TABLE "matches" (
    id            INTEGER PRIMARY KEY,
    check_id      INTEGER NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    rule_id       INTEGER NOT NULL,
    version_id    INTEGER NOT NULL,
    condition_id  INTEGER NOT NULL,
    score         REAL NOT NULL
  );
CREATE TABLE turns (
    id                INTEGER PRIMARY KEY,
    created_at        TEXT NOT NULL,
    session_id        TEXT,
    message_check_id  INTEGER REFERENCES checks (id) ON DELETE SET NULL,
    reply_check_id    INTEGER REFERENCES checks (id) ON DELETE SET NULL,
    reply             TEXT NOT NULL,
    revised_reply     TEXT,
    revised_at        TEXT
  );
CREATE INDEX turns_by_session ON turns (session_id);
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  REAL NOT NULL
  );
CREATE TABLE projects (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    first_seen_at  TEXT NOT NULL
  );
CREATE INDEX checks_by_project ON checks (project_id);
CREATE TABLE version_projects (
    version_id  INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    project_id  INTEGER NOT NULL REFERENCES projects (id),
    PRIMARY KEY (version_id, project_id)
  );
CREATE INDEX checks_by_session ON checks (session_id);
CREATE INDEX matches_by_check ON matches (check_id);
CREATE INDEX matches_by_rule ON matches (rule_id);
CREATE TABLE "flags" (
    id          INTEGER PRIMARY KEY,
    match_id    INTEGER NOT NULL UNIQUE REFERENCES matches (id) ON DELETE CASCADE,
    verdict     TEXT NOT NULL CHECK (verdict IN ('wrong', 'right')),
    raised_by   TEXT NOT NULL CHECK (raised_by IN ('claude', 'user')),
    created_at  TEXT NOT NULL
  );
CREATE TABLE "saved_cases" (
    id          INTEGER PRIMARY KEY,
    rule_id     INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    check_type  TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    text        TEXT NOT NULL,
    expected    TEXT NOT NULL CHECK (expected IN ('should_match', 'should_not_match')),
    flag_id     INTEGER REFERENCES "flags" (id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
  );
CREATE INDEX saved_cases_by_rule ON saved_cases (rule_id);
`;
