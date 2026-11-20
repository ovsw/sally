import { RuleError, RuleNotFoundError } from "./errors.ts";
import type { CheckType } from "./rules.ts";
import { type Store, transaction } from "./store.ts";

/** Who marked a false positive: Claude (with the `false-positive` command) or the user in the app. */
export type MarkedBy = "claude" | "user";

export const MARKED_BY: readonly MarkedBy[] = Object.freeze(["claude", "user"]);

/** The mark on a match that was a false positive. */
export interface FalsePositiveMark {
  markedBy: MarkedBy;
  markedAt: string;
}

export interface MarkResult {
  ruleId: number;
  matchId: number;
  /** When the marked match's check ran. */
  checkedAt: string;
  /** The match's mark as it now stands. */
  mark: FalsePositiveMark;
  /** False when the match was already marked, and that mark was kept. */
  recorded: boolean;
}

/**
 * A match of a rule marked as a false positive: the rule matched a message or
 * reply it did not apply to. A new version of the rule should not match it.
 */
export interface FalsePositive extends FalsePositiveMark {
  matchId: number;
  ruleId: number;
  /** The check the match happened in, and the text it checked. */
  checkId: number;
  checkType: CheckType;
  text: string;
  /** The rule version that matched; null when that version is gone. */
  versionNumber: number | null;
}

export interface FalsePositives {
  /**
   * Marks a match as a false positive. A match holds one mark: marking it again
   * keeps the mark it has, except that the user's mark replaces Claude's.
   */
  markFalsePositive(matchId: number, markedBy: MarkedBy): MarkResult;
  /** The user takes a match's false-positive mark away, whoever made it. */
  unmarkFalsePositive(matchId: number): void;
  /**
   * Claude's report that a rule it was handed did not apply: marks the
   * session's most recent match of the rule (by the name Claude saw, ignoring
   * case) as a false positive.
   */
  reportFalsePositive(sessionId: string, ruleName: string): MarkResult;
  /** The rule's false positives, newest first. */
  falsePositives(ruleId: number): FalsePositive[];
}

const now = () => new Date().toISOString();

type MarkRow = { marked_by: MarkedBy; created_at: string };

const markView = (row: MarkRow): FalsePositiveMark => ({ markedBy: row.marked_by, markedAt: row.created_at });

/** `requireRule` refuses a rule that does not exist. */
export function createFalsePositives(db: Store, requireRule: (ruleId: number) => unknown): FalsePositives {
  function requireMatch(matchId: number): { rule_id: number; created_at: string } {
    const match = db
      .prepare("SELECT f.rule_id, c.created_at FROM matches f JOIN checks c ON c.id = f.check_id WHERE f.id = ?")
      .get(matchId) as { rule_id: number; created_at: string } | undefined;
    if (!match) throw new RuleNotFoundError(`No match with id ${matchId}.`);
    requireRule(match.rule_id);
    return match;
  }

  function mark(matchId: number, markedBy: MarkedBy): MarkResult {
    const match = requireMatch(matchId);
    const result = { ruleId: match.rule_id, matchId, checkedAt: match.created_at };
    const existing = db.prepare("SELECT marked_by, created_at FROM false_positives WHERE match_id = ?").get(matchId) as
      | MarkRow
      | undefined;
    if (existing && (existing.marked_by === "user" || markedBy !== "user")) {
      return { ...result, mark: markView(existing), recorded: false };
    }
    const markedAt = now();
    db.prepare(
      `INSERT INTO false_positives (match_id, marked_by, created_at) VALUES (?, ?, ?)
       ON CONFLICT (match_id) DO UPDATE SET marked_by = excluded.marked_by, created_at = excluded.created_at`,
    ).run(matchId, markedBy, markedAt);
    return { ...result, mark: { markedBy, markedAt }, recorded: true };
  }

  return {
    markFalsePositive(matchId, markedBy) {
      if (!MARKED_BY.includes(markedBy)) throw new RuleError("A false positive is marked by Claude or the user.");
      return transaction(db, () => mark(matchId, markedBy));
    },

    unmarkFalsePositive(matchId) {
      transaction(db, () => {
        requireMatch(matchId);
        db.prepare("DELETE FROM false_positives WHERE match_id = ?").run(matchId);
      });
    },

    reportFalsePositive(sessionId, ruleName) {
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
        return mark(row.id, "claude");
      });
    },

    falsePositives(ruleId) {
      requireRule(ruleId);
      const rows = db
        .prepare(
          `SELECT fp.match_id, fp.marked_by, fp.created_at, f.rule_id, c.id AS check_id, c.check_type, c.text,
                  v.number AS version_number
             FROM false_positives fp
             JOIN matches f ON f.id = fp.match_id
             JOIN checks c ON c.id = f.check_id
             LEFT JOIN versions v ON v.id = f.version_id
            WHERE f.rule_id = ?
            ORDER BY fp.created_at DESC, fp.match_id DESC`,
        )
        .all(ruleId) as (MarkRow & {
        match_id: number;
        rule_id: number;
        check_id: number;
        check_type: CheckType;
        text: string;
        version_number: number | null;
      })[];
      return rows.map((row) => ({
        matchId: row.match_id,
        ruleId: row.rule_id,
        checkId: row.check_id,
        checkType: row.check_type,
        text: row.text,
        versionNumber: row.version_number,
        ...markView(row),
      }));
    },
  };
}
