import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Store = DatabaseSync;

/**
 * Schema migrations, applied in order. The database's user_version is the
 * number of migrations already applied. Add new ones at the end; never edit
 * one that has shipped.
 */
const migrations: string[] = [
  `
  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    check_type  TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    created_at  TEXT NOT NULL
  );

  -- A version holds the instruction and the conditions. The draft is the one
  -- version with no number; published versions are numbered and immutable.
  CREATE TABLE versions (
    id            INTEGER PRIMARY KEY,
    rule_id       INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    number        INTEGER,
    instruction   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    published_at  TEXT,
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
  );

  CREATE TABLE scores (
    check_id      INTEGER NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    rule_id       INTEGER NOT NULL,
    version_id    INTEGER NOT NULL,
    condition_id  INTEGER NOT NULL,
    score         REAL NOT NULL
  );
  CREATE INDEX scores_by_check ON scores (check_id);
  CREATE INDEX scores_by_version ON scores (version_id);

  -- One row per rule that fired; condition_id is its highest-scoring condition.
  CREATE TABLE firings (
    id            INTEGER PRIMARY KEY,
    check_id      INTEGER NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
    rule_id       INTEGER NOT NULL,
    version_id    INTEGER NOT NULL,
    condition_id  INTEGER NOT NULL,
    score         REAL NOT NULL
  );
  CREATE INDEX firings_by_check ON firings (check_id);
  CREATE INDEX firings_by_rule ON firings (rule_id);
  `,
  `
  -- One row per turn that ended with a reply: Claude's final reply, tied to the
  -- turn's message check, and the revised reply after a send-back.
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
  `,
  `
  -- Engine settings by key; a key with no row takes its default.
  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  REAL NOT NULL
  );

  -- The cap in force for each check, and whether the cap dropped a firing.
  ALTER TABLE checks ADD COLUMN cap INTEGER;
  ALTER TABLE firings ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped IN (0, 1));
  `,
  `
  -- The name is part of a version, so renaming a rule in its draft changes
  -- nothing until it is published. rules.name stays the name in force: the
  -- live version's, or the draft's while the rule has never been published.
  ALTER TABLE versions ADD COLUMN name TEXT NOT NULL DEFAULT '';
  UPDATE versions SET name = (SELECT name FROM rules WHERE rules.id = versions.rule_id);
  `,
  `
  -- A project is the git repository a session runs in, named by its remote as
  -- owner/name, or a folder path outside any repository. Recorded when first seen.
  CREATE TABLE projects (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    first_seen_at  TEXT NOT NULL
  );

  ALTER TABLE checks ADD COLUMN project_id INTEGER REFERENCES projects (id);
  CREATE INDEX checks_by_project ON checks (project_id);

  -- A version's scope is part of the version, like its name: all projects, or
  -- only the projects listed for it in version_projects.
  ALTER TABLE versions ADD COLUMN all_projects INTEGER NOT NULL DEFAULT 1 CHECK (all_projects IN (0, 1));
  CREATE TABLE version_projects (
    version_id  INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    project_id  INTEGER NOT NULL REFERENCES projects (id),
    PRIMARY KEY (version_id, project_id)
  );
  `,
];

/**
 * Opens (creating if needed) the SQLite database at `path`, set up so that
 * several sessions can write at once, and brings its schema up to date.
 */
export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = () => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current() >= migrations.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let v = current(); v < migrations.length; v++) {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Runs `fn` inside one write transaction. */
export function transaction<T>(db: Store, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
