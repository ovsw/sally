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

  -- Retired: checks.cap and firings.dropped belonged to a limit on the rules
  -- attached in one check. Nothing reads or writes them; a later migration
  -- drops them.
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
  `
  -- A rule switched off keeps its versions and draft but is never sent to the matcher.
  ALTER TABLE rules ADD COLUMN switched_off INTEGER NOT NULL DEFAULT 0 CHECK (switched_off IN (0, 1));
  `,
  `
  -- The check type is part of a version too, so moving a rule between the
  -- message check and the reply check in its draft changes nothing until it is
  -- published. rules.check_type stays the check type in force, as with names.
  ALTER TABLE versions ADD COLUMN check_type TEXT NOT NULL DEFAULT 'message'
    CHECK (check_type IN ('message', 'reply'));
  UPDATE versions SET check_type = (SELECT check_type FROM rules WHERE rules.id = versions.rule_id);
  `,
  `
  -- A verdict on one firing: wrong (the rule did not apply) or correct, and who
  -- raised it. A firing holds one flag; a later one replaces it, except that
  -- the user's own flag is never replaced by Claude's or the automatic check's.
  CREATE TABLE flags (
    id          INTEGER PRIMARY KEY,
    firing_id   INTEGER NOT NULL UNIQUE REFERENCES firings (id) ON DELETE CASCADE,
    verdict     TEXT NOT NULL CHECK (verdict IN ('wrong', 'correct')),
    raised_by   TEXT NOT NULL CHECK (raised_by IN ('claude', 'user', 'automatic')),
    created_at  TEXT NOT NULL
  );

  -- A real message or reply kept with a rule, with the outcome it should have.
  -- flag_id is where it came from; a case goes with the flag that made it.
  CREATE TABLE saved_cases (
    id          INTEGER PRIMARY KEY,
    rule_id     INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    check_type  TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    text        TEXT NOT NULL,
    expected    TEXT NOT NULL CHECK (expected IN ('should_fire', 'should_not_fire')),
    flag_id     INTEGER REFERENCES flags (id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX saved_cases_by_rule ON saved_cases (rule_id);
  CREATE INDEX checks_by_session ON checks (session_id);
  `,
  `
  -- Jev's limits: whether the text was cut to its last part to fit the
  -- per-question limit, and the input tokens of the check's largest request
  -- (input_tokens is the total when the conditions were split across requests).
  ALTER TABLE checks ADD COLUMN cut INTEGER NOT NULL DEFAULT 0 CHECK (cut IN (0, 1));
  ALTER TABLE checks ADD COLUMN request_tokens INTEGER;
  `,
  `
  -- The vocabulary pass. A rule that reaches the cutoff in a check is a match,
  -- a flag's verdict is wrong or right, a flag is raised by Claude or the user,
  -- and a saved case should match or should not match. The retired columns
  -- checks.cap and dropped (on the matches table) go too.
  ALTER TABLE firings RENAME TO matches;
  DROP INDEX firings_by_check;
  DROP INDEX firings_by_rule;
  ALTER TABLE matches DROP COLUMN dropped;
  ALTER TABLE checks DROP COLUMN cap;
  CREATE INDEX matches_by_check ON matches (check_id);
  CREATE INDEX matches_by_rule ON matches (rule_id);

  -- The CHECK constraints change, so flags and saved_cases are rebuilt. The
  -- old saved_cases goes before the old flags, so that dropping flags does not
  -- cascade into the saved cases. Nothing ever raised an automatic flag; any
  -- there is becomes Claude's, which the user's own flag can still replace.
  CREATE TABLE new_flags (
    id          INTEGER PRIMARY KEY,
    match_id    INTEGER NOT NULL UNIQUE REFERENCES matches (id) ON DELETE CASCADE,
    verdict     TEXT NOT NULL CHECK (verdict IN ('wrong', 'right')),
    raised_by   TEXT NOT NULL CHECK (raised_by IN ('claude', 'user')),
    created_at  TEXT NOT NULL
  );
  INSERT INTO new_flags (id, match_id, verdict, raised_by, created_at)
    SELECT id, firing_id,
           CASE verdict WHEN 'correct' THEN 'right' ELSE verdict END,
           CASE raised_by WHEN 'automatic' THEN 'claude' ELSE raised_by END,
           created_at
      FROM flags;

  CREATE TABLE new_saved_cases (
    id          INTEGER PRIMARY KEY,
    rule_id     INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    check_type  TEXT NOT NULL CHECK (check_type IN ('message', 'reply')),
    text        TEXT NOT NULL,
    expected    TEXT NOT NULL CHECK (expected IN ('should_match', 'should_not_match')),
    flag_id     INTEGER REFERENCES new_flags (id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
  );
  INSERT INTO new_saved_cases (id, rule_id, check_type, text, expected, flag_id, created_at)
    SELECT id, rule_id, check_type, text,
           CASE expected WHEN 'should_fire' THEN 'should_match' ELSE 'should_not_match' END,
           flag_id, created_at
      FROM saved_cases;

  DROP TABLE saved_cases;
  DROP TABLE flags;
  ALTER TABLE new_flags RENAME TO flags;
  ALTER TABLE new_saved_cases RENAME TO saved_cases;
  CREATE INDEX saved_cases_by_rule ON saved_cases (rule_id);
  `,
  `
  -- A failed check now stops the turn. The setting is written down as on (1)
  -- in every database, so that what an existing installation does is stated
  -- in its own settings and not only by the default.
  INSERT INTO settings (key, value) VALUES ('stop_on_failure', 1) ON CONFLICT (key) DO NOTHING;
  `,
  `
  -- An attention reason the user looked at and judged fine. It is kept against
  -- the version it was about, so a newly published version is judged afresh.
  -- Wrong matches are not cleared this way: they go when the rule is fixed.
  CREATE TABLE cleared_reasons (
    version_id  INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('matches_often', 'weak_matches', 'never_matches')),
    created_at  TEXT NOT NULL,
    PRIMARY KEY (version_id, kind)
  );
  `,
  `
  -- An import turns the conditional rules in one rules file into drafts. Its
  -- rules apply to all projects (all_projects = 1) or to its one project.
  -- removed_at is when the published rules were removed from the file.
  CREATE TABLE imports (
    id            INTEGER PRIMARY KEY,
    rules_file    TEXT NOT NULL,
    all_projects  INTEGER NOT NULL CHECK (all_projects IN (0, 1)),
    project_id    INTEGER REFERENCES projects (id),
    created_at    TEXT NOT NULL,
    removed_at    TEXT,
    CHECK ((all_projects = 1) = (project_id IS NULL))
  );

  -- A passage is a piece of the rules file that says one thing, in file order.
  -- verdict is what the import proposed; decision is the user's overrule, if
  -- any; seen_at is when the user looked at it.
  CREATE TABLE passages (
    id            INTEGER PRIMARY KEY,
    import_id     INTEGER NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    text          TEXT NOT NULL,
    verdict       TEXT NOT NULL CHECK (verdict IN ('becomes_rule', 'always_rule', 'too_vague')),
    reason        TEXT NOT NULL,
    similar_rule  TEXT,
    decision      TEXT CHECK (decision IN ('becomes_rule', 'stays')),
    seen_at       TEXT,
    UNIQUE (import_id, position)
  );

  -- The rules a passage produced, in order. A rule is created as a draft; a
  -- skipped one is deleted, so rule_id goes to NULL and the row keeps the
  -- decision. A published rule needs no decision: its live version says so.
  CREATE TABLE passage_rules (
    id          INTEGER PRIMARY KEY,
    passage_id  INTEGER NOT NULL REFERENCES passages (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    rule_id     INTEGER UNIQUE REFERENCES rules (id) ON DELETE SET NULL,
    decision    TEXT CHECK (decision IN ('kept', 'skipped')),
    decided_at  TEXT,
    UNIQUE (passage_id, position)
  );
  `,
  `
  -- Reply checks get their own cutoff. A database whose cutoff was changed
  -- keeps judging replies at that cutoff, as it did before; one that never
  -- changed it takes the default for both.
  INSERT INTO settings (key, value)
    SELECT 'reply_cutoff', value FROM settings WHERE key = 'cutoff'
    ON CONFLICT (key) DO NOTHING;
  `,
  `
  -- A rule no longer has a check type. Each condition has a Message switch and
  -- a Reply switch, and a rule takes part in a check when one of its conditions
  -- is on for that check type. A condition now lasts: it belongs to its rule
  -- and outlives versions, and a version holds only its wording and position
  -- (version_conditions). Each existing condition is on for its rule's check
  -- type. The same wording across a rule's versions becomes one condition,
  -- which keeps the lowest of the old ids, and scores and matches are pointed
  -- at it. A draft that was moving its rule to the other check keeps that
  -- pending move: its conditions stay apart from the published ones and are on
  -- for the draft's check type, so publishing it still changes the check.
  -- versions.check_type is retired: nothing reads or writes it after this.
  CREATE TEMP TABLE condition_map AS
    SELECT c.id AS old_id, v.rule_id, c.version_id, c.position, c.text,
           v.number IS NULL AND v.check_type <> r.check_type AS moving,
           v.check_type AS check_type,
           ROW_NUMBER() OVER (PARTITION BY c.version_id, c.text ORDER BY c.position, c.id) AS occurrence
      FROM conditions c JOIN versions v ON v.id = c.version_id JOIN rules r ON r.id = v.rule_id;
  CREATE TEMP TABLE condition_ids AS
    SELECT m.old_id, m.rule_id, m.version_id, m.position, m.text, m.moving, m.check_type,
           (SELECT MIN(o.old_id) FROM condition_map o
             WHERE o.rule_id = m.rule_id AND o.text = m.text AND o.occurrence = m.occurrence
               AND o.moving = m.moving) AS new_id
      FROM condition_map m;
  CREATE INDEX condition_ids_by_old ON condition_ids (old_id);

  -- AUTOINCREMENT: a deleted condition's id is never given to a later one, so
  -- an id kept by an undo step cannot come to mean another condition.
  CREATE TABLE lasting_conditions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id  INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
    message  INTEGER NOT NULL CHECK (message IN (0, 1)),
    reply    INTEGER NOT NULL CHECK (reply IN (0, 1))
  );
  INSERT INTO lasting_conditions (id, rule_id, message, reply)
    SELECT DISTINCT m.new_id, m.rule_id,
           CASE WHEN m.moving THEN m.check_type ELSE r.check_type END = 'message',
           CASE WHEN m.moving THEN m.check_type ELSE r.check_type END = 'reply'
      FROM condition_ids m JOIN rules r ON r.id = m.rule_id;

  CREATE TABLE version_conditions (
    version_id    INTEGER NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
    condition_id  INTEGER NOT NULL REFERENCES lasting_conditions (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    text          TEXT NOT NULL,
    PRIMARY KEY (version_id, condition_id)
  );
  INSERT INTO version_conditions (version_id, condition_id, position, text)
    SELECT version_id, new_id, position, text FROM condition_ids;

  UPDATE scores SET condition_id = (SELECT new_id FROM condition_ids WHERE old_id = scores.condition_id)
   WHERE condition_id IN (SELECT old_id FROM condition_ids WHERE old_id <> new_id);
  UPDATE matches SET condition_id = (SELECT new_id FROM condition_ids WHERE old_id = matches.condition_id)
   WHERE condition_id IN (SELECT old_id FROM condition_ids WHERE old_id <> new_id);

  DROP TABLE conditions;
  ALTER TABLE lasting_conditions RENAME TO conditions;
  CREATE INDEX conditions_by_rule ON conditions (rule_id);
  CREATE INDEX version_conditions_by_condition ON version_conditions (condition_id);
  ALTER TABLE rules DROP COLUMN check_type;
  DROP TABLE condition_ids;
  DROP TABLE condition_map;
  `,
];

/**
 * Opens (creating if needed) the SQLite database at `path`, set up so that
 * several sessions can write at once, and brings its schema up to date.
 */
export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (error) {
    // Do not keep a file open that turned out not to be a usable database.
    db.close();
    throw error;
  }
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

/**
 * Runs `fn` inside one write transaction. Inside another transaction it runs
 * in a savepoint, so its changes still go or stay with the outer one.
 */
export function transaction<T>(db: Store, fn: () => T): T {
  if (db.isTransaction) {
    db.exec("SAVEPOINT nested");
    try {
      const result = fn();
      db.exec("RELEASE nested");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO nested");
      db.exec("RELEASE nested");
      throw error;
    }
  }
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
