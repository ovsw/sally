import { RuleError, RuleNotFoundError } from "./errors.ts";
import type { CheckType } from "./rules.ts";
import { type Store, transaction } from "./store.ts";

/** A wrong match is a match of a rule that did not apply; a right match is a match of one that did. */
export type Verdict = "wrong" | "right";

/** Who raised a flag: Claude (with `sally wrong-match`) or the user in the app. */
export type RaisedBy = "claude" | "user";

/** What a saved case expects of its rule on its text. */
export type Expected = "should_match" | "should_not_match";

export const VERDICTS: readonly Verdict[] = Object.freeze(["wrong", "right"]);
export const RAISED_BY: readonly RaisedBy[] = Object.freeze(["claude", "user"]);

export interface FlagView {
  verdict: Verdict;
  raisedBy: RaisedBy;
  createdAt: string;
}

export interface FlagResult {
  ruleId: number;
  matchId: number;
  /** When the flagged match's check ran. */
  checkedAt: string;
  /** The match's flag as it now stands. */
  flag: FlagView;
  /** False when the match already held the user's own flag, which was kept instead. */
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
  /** Where it came from: the flag that made it, on a match of this version in this check. */
  source: { verdict: Verdict; raisedBy: RaisedBy; checkId: number; versionNumber: number | null } | null;
}

export interface Flags {
  /**
   * Flags a match wrong or right and keeps its text as a saved case for its
   * rule: a wrong match should not match, a right one should. A match holds
   * one flag, so a new one replaces the old one and its saved case, except
   * that the user's own flag is never replaced by Claude's.
   */
  flagMatch(matchId: number, verdict: Verdict, raisedBy: RaisedBy): FlagResult;
  /**
   * Claude's report that a rule it was handed did not apply: flags the
   * session's most recent match of the rule (by the name Claude saw, ignoring
   * case) as a wrong match raised by Claude.
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
  function flag(matchId: number, verdict: Verdict, raisedBy: RaisedBy): FlagResult {
    const match = db
      .prepare(
        `SELECT f.rule_id, c.check_type, c.text, c.created_at
           FROM matches f JOIN checks c ON c.id = f.check_id
          WHERE f.id = ?`,
      )
      .get(matchId) as { rule_id: number; check_type: CheckType; text: string; created_at: string } | undefined;
    if (!match) throw new RuleNotFoundError(`No match with id ${matchId}.`);
    requireRule(match.rule_id);
    const result = { ruleId: match.rule_id, matchId, checkedAt: match.created_at };

    const existing = db.prepare("SELECT id, verdict, raised_by, created_at FROM flags WHERE match_id = ?").get(matchId) as
      | (FlagRow & { id: number })
      | undefined;
    if (existing?.raised_by === "user" && raisedBy !== "user") {
      return { ...result, flag: flagView(existing), recorded: false };
    }
    // The old flag's saved case goes with it.
    if (existing) db.prepare("DELETE FROM flags WHERE id = ?").run(existing.id);

    const createdAt = now();
    const { lastInsertRowid: flagId } = db
      .prepare("INSERT INTO flags (match_id, verdict, raised_by, created_at) VALUES (?, ?, ?, ?)")
      .run(matchId, verdict, raisedBy, createdAt);
    db.prepare(
      `INSERT INTO saved_cases (rule_id, check_type, text, expected, flag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      match.rule_id,
      match.check_type,
      match.text,
      verdict === "wrong" ? "should_not_match" : "should_match",
      flagId,
      createdAt,
    );
    return { ...result, flag: { verdict, raisedBy, createdAt }, recorded: true };
  }

  return {
    flagMatch(matchId, verdict, raisedBy) {
      if (!VERDICTS.includes(verdict)) throw new RuleError("A flag's verdict is wrong or right.");
      if (!RAISED_BY.includes(raisedBy)) throw new RuleError("A flag is raised by Claude or the user.");
      return transaction(db, () => flag(matchId, verdict, raisedBy));
    },

    reportWrongMatch(sessionId, ruleName) {
      const name = ruleName.trim();
      if (!sessionId.trim()) throw new RuleError("No session to look in: run this from a Claude Code session.");
      if (!name) throw new RuleError("Name the rule that did not apply.");
      return transaction(db, () => {
        // The name Claude saw is the matched version's; the rule's current name counts too.
        const row = db
          .prepare(
            `SELECT f.id FROM matches f
               JOIN checks c ON c.id = f.check_id
               JOIN rules r ON r.id = f.rule_id
               LEFT JOIN versions v ON v.id = f.version_id
              WHERE c.session_id = ?
                AND (lower(v.name) = lower(?) OR lower(r.name) = lower(?))
              ORDER BY (v.name = ? OR r.name = ?) DESC, f.id DESC
              LIMIT 1`,
          )
          .get(sessionId, name, name, name, name) as { id: number } | undefined;
        if (!row) throw new RuleNotFoundError(`No rule named "${name}" has matched in this session.`);
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
             LEFT JOIN matches f ON f.id = fl.match_id
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
