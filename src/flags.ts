import { RuleError, RuleNotFoundError } from "./errors.ts";
import type { CheckType } from "./rules.ts";
import { type Store, transaction } from "./store.ts";

/** A wrong match is a firing of a rule that did not apply; a correct one is a firing that did. */
export type Verdict = "wrong" | "correct";

/** Who raised a flag: Claude (with `sally wrong-match`), the user in the app, or the automatic check. */
export type RaisedBy = "claude" | "user" | "automatic";

/** What a saved case expects of its rule on its text. */
export type Expected = "should_fire" | "should_not_fire";

export const VERDICTS: readonly Verdict[] = Object.freeze(["wrong", "correct"]);
export const RAISED_BY: readonly RaisedBy[] = Object.freeze(["claude", "user", "automatic"]);

export interface FlagView {
  verdict: Verdict;
  raisedBy: RaisedBy;
  createdAt: string;
}

export interface FlagResult {
  ruleId: number;
  firingId: number;
  /** When the flagged firing's check ran. */
  checkedAt: string;
  /** The firing's flag as it now stands. */
  flag: FlagView;
  /** False when the firing already held the user's own flag, which was kept instead. */
  recorded: boolean;
}

/** A real message or reply kept with a rule, marked with the outcome it should have. */
export interface SavedCaseView {
  id: number;
  ruleId: number;
  checkType: CheckType;
  text: string;
  expected: Expected;
  createdAt: string;
  /** Where it came from: the flag that made it, on a firing of this version in this check. */
  source: { verdict: Verdict; raisedBy: RaisedBy; checkId: number; versionNumber: number | null } | null;
}

export interface Flags {
  /**
   * Flags a firing wrong or correct and keeps its text as a saved case for its
   * rule: a wrong match should not fire, a correct one should. A firing holds
   * one flag, so a new one replaces the old one and its saved case, except
   * that the user's own flag is never replaced by Claude's or the automatic
   * check's.
   */
  flagFiring(firingId: number, verdict: Verdict, raisedBy: RaisedBy): FlagResult;
  /**
   * Claude's report that a rule it was handed did not apply: flags the
   * session's most recent firing of the rule (by the name Claude saw, ignoring
   * case) as a wrong match raised by Claude. Firings the cap dropped never
   * reached Claude and are passed over.
   */
  reportWrongMatch(sessionId: string, ruleName: string): FlagResult;
  /** The rule's saved cases, newest first. */
  savedCases(ruleId: number): SavedCaseView[];
}

const now = () => new Date().toISOString();

type FlagRow = { verdict: Verdict; raised_by: RaisedBy; created_at: string };

const flagView = (row: FlagRow): FlagView => ({ verdict: row.verdict, raisedBy: row.raised_by, createdAt: row.created_at });

/** `requireRule` refuses a rule that does not exist. */
export function createFlags(db: Store, requireRule: (ruleId: number) => unknown): Flags {
  function flag(firingId: number, verdict: Verdict, raisedBy: RaisedBy): FlagResult {
    const firing = db
      .prepare(
        `SELECT f.rule_id, c.check_type, c.text, c.created_at
           FROM firings f JOIN checks c ON c.id = f.check_id
          WHERE f.id = ?`,
      )
      .get(firingId) as { rule_id: number; check_type: CheckType; text: string; created_at: string } | undefined;
    if (!firing) throw new RuleNotFoundError(`No firing with id ${firingId}.`);
    requireRule(firing.rule_id);
    const result = { ruleId: firing.rule_id, firingId, checkedAt: firing.created_at };

    const existing = db.prepare("SELECT id, verdict, raised_by, created_at FROM flags WHERE firing_id = ?").get(firingId) as
      | (FlagRow & { id: number })
      | undefined;
    if (existing?.raised_by === "user" && raisedBy !== "user") {
      return { ...result, flag: flagView(existing), recorded: false };
    }
    // The old flag's saved case goes with it.
    if (existing) db.prepare("DELETE FROM flags WHERE id = ?").run(existing.id);

    const createdAt = now();
    const { lastInsertRowid: flagId } = db
      .prepare("INSERT INTO flags (firing_id, verdict, raised_by, created_at) VALUES (?, ?, ?, ?)")
      .run(firingId, verdict, raisedBy, createdAt);
    db.prepare(
      `INSERT INTO saved_cases (rule_id, check_type, text, expected, flag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      firing.rule_id,
      firing.check_type,
      firing.text,
      verdict === "wrong" ? "should_not_fire" : "should_fire",
      flagId,
      createdAt,
    );
    return { ...result, flag: { verdict, raisedBy, createdAt }, recorded: true };
  }

  return {
    flagFiring(firingId, verdict, raisedBy) {
      if (!VERDICTS.includes(verdict)) throw new RuleError("A flag's verdict is wrong or correct.");
      if (!RAISED_BY.includes(raisedBy)) throw new RuleError("A flag is raised by Claude, the user or the automatic check.");
      return transaction(db, () => flag(firingId, verdict, raisedBy));
    },

    reportWrongMatch(sessionId, ruleName) {
      const name = ruleName.trim();
      if (!sessionId.trim()) throw new RuleError("No session to look in: run this from a Claude Code session.");
      if (!name) throw new RuleError("Name the rule that did not apply.");
      return transaction(db, () => {
        // The name Claude saw is the fired version's; the rule's current name counts too.
        const row = db
          .prepare(
            `SELECT f.id FROM firings f
               JOIN checks c ON c.id = f.check_id
               JOIN rules r ON r.id = f.rule_id
               LEFT JOIN versions v ON v.id = f.version_id
              WHERE c.session_id = ? AND f.dropped = 0
                AND (lower(v.name) = lower(?) OR lower(r.name) = lower(?))
              ORDER BY (v.name = ? OR r.name = ?) DESC, f.id DESC
              LIMIT 1`,
          )
          .get(sessionId, name, name, name, name) as { id: number } | undefined;
        if (!row) throw new RuleNotFoundError(`No rule named "${name}" has fired in this session.`);
        return flag(row.id, "wrong", "claude");
      });
    },

    savedCases(ruleId) {
      requireRule(ruleId);
      const rows = db
        .prepare(
          `SELECT sc.id, sc.rule_id, sc.check_type, sc.text, sc.expected, sc.created_at,
                  fl.verdict, fl.raised_by, f.check_id, v.number AS version_number
             FROM saved_cases sc
             LEFT JOIN flags fl ON fl.id = sc.flag_id
             LEFT JOIN firings f ON f.id = fl.firing_id
             LEFT JOIN versions v ON v.id = f.version_id
            WHERE sc.rule_id = ?
            ORDER BY sc.id DESC`,
        )
        .all(ruleId) as {
        id: number;
        rule_id: number;
        check_type: CheckType;
        text: string;
        expected: Expected;
        created_at: string;
        verdict: Verdict | null;
        raised_by: RaisedBy | null;
        check_id: number | null;
        version_number: number | null;
      }[];
      return rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        checkType: row.check_type,
        text: row.text,
        expected: row.expected,
        createdAt: row.created_at,
        source:
          row.verdict && row.raised_by && row.check_id !== null
            ? { verdict: row.verdict, raisedBy: row.raised_by, checkId: row.check_id, versionNumber: row.version_number }
            : null,
      }));
    },
  };
}
