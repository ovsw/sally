import type { Outcome } from "./engine.ts";
import type { FlagView } from "./flags.ts";
import type { CheckType } from "./rules.ts";
import type { Store } from "./store.ts";

/**
 * How far under the cutoff a rule's best score may sit and still count as a
 * near miss.
 */
export const NEAR_MISS_MARGIN = 0.1;

/** Slack for float rounding, so a score exactly the margin under the cutoff (0.7 under 0.8) still counts. */
const EPSILON = 1e-9;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const OUTCOMES: readonly Outcome[] = Object.freeze(["nothing", "attached", "sent_back", "skipped", "failed"]);

export interface ActivityFilter {
  /** Only checks with one of these outcomes; all outcomes when left out or empty. */
  outcomes?: Outcome[];
  checkType?: CheckType;
  /** How many of the most recent checks to return: 100 by default, at most 500. */
  limit?: number;
}

/** A rule that fired in a check. */
export interface ActivityFiring {
  ruleId: number;
  /** The rule's name in the version that fired; null when the rule has since been deleted. */
  name: string | null;
  score: number;
  /** True when the cap dropped it, so it was not attached or sent back. */
  dropped: boolean;
}

/** One check, as the Activity screen shows it. */
export interface ActivityCheck {
  id: number;
  createdAt: string;
  /** The project the check ran in; null when the session had no folder. */
  project: string | null;
  sessionId: string | null;
  checkType: CheckType;
  /** The text checked. */
  text: string;
  outcome: Outcome;
  /** Why the check failed (a timeout, an engine error), or null. */
  error: string | null;
  durationMs: number;
  inputTokens: number | null;
  /** The rules that fired, strongest first, including those the cap dropped. */
  firings: ActivityFiring[];
}

/** A check a rule was scored in, with the rule's best condition and score there. */
export interface RuleCheckView {
  checkId: number;
  createdAt: string;
  project: string | null;
  text: string;
  /** The rule's highest score in the check. */
  score: number;
  /** The cutoff in force for the check. */
  cutoff: number;
  /** The rule version that was scored. */
  versionNumber: number | null;
  /** The condition that scored highest. */
  condition: string | null;
}

export interface RuleFiringView extends RuleCheckView {
  firingId: number;
  /** True when the cap dropped it, so it was not attached or sent back. */
  dropped: boolean;
  /** The firing's flag, wrong or correct, and who raised it; null when unflagged. */
  flag: FlagView | null;
}

/** One published version's own performance. */
export interface VersionPerformance {
  number: number;
  publishedAt: string;
  /** Checks this version was scored in. */
  checks: number;
  /** Times this version fired and was attached or sent back. */
  firings: number;
  /** This version's firings flagged as wrong matches. */
  wrongMatches: number;
}

/** How a rule has behaved, across all its versions. */
export interface RuleAnalytics {
  /** Checks the rule was scored in. */
  checks: number;
  /** Times the rule fired and was attached or sent back. */
  firings: number;
  /** Times the rule fired but the cap dropped it. */
  dropped: number;
  /** Firings flagged as wrong matches. */
  wrongMatches: number;
  /** The most recent firings, newest first, including those the cap dropped. */
  recentFirings: RuleFiringView[];
  /** The most recent checks where the rule's best score sat just under the cutoff, newest first. */
  nearMisses: RuleCheckView[];
  /** How far under the cutoff a near miss may be. */
  nearMissMargin: number;
  /** Every published version, newest first. */
  versions: VersionPerformance[];
}

export interface AnalyticsQueries {
  /** The most recent checks, newest first, with what each attached or sent back. */
  activity(filter?: ActivityFilter): ActivityCheck[];
  /** How often the rule fired, on what and with what flags, its near misses, and each version's firing and wrong-match counts. */
  ruleAnalytics(ruleId: number, options?: { limit?: number }): RuleAnalytics;
}

function limitOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

type CheckViewRow = {
  check_id: number;
  created_at: string;
  project: string | null;
  text: string;
  score: number;
  cutoff: number;
  version_number: number | null;
  condition: string | null;
};

const checkView = (row: CheckViewRow): RuleCheckView => ({
  checkId: row.check_id,
  createdAt: row.created_at,
  project: row.project,
  text: row.text,
  score: row.score,
  cutoff: row.cutoff,
  versionNumber: row.version_number,
  condition: row.condition,
});

/**
 * The read-only queries behind the Activity screen and a rule's analytics.
 * `requireRule` refuses a rule that does not exist.
 */
export function createAnalyticsQueries(db: Store, requireRule: (ruleId: number) => unknown): AnalyticsQueries {
  return {
    activity(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      const outcomes = filter.outcomes?.filter((o) => OUTCOMES.includes(o)) ?? [];
      if (outcomes.length > 0) {
        where.push(`c.outcome IN (${outcomes.map(() => "?").join(", ")})`);
        params.push(...outcomes);
      }
      if (filter.checkType) {
        where.push("c.check_type = ?");
        params.push(filter.checkType);
      }
      const rows = db
        .prepare(
          `SELECT c.id, c.created_at, p.name AS project, c.session_id, c.check_type, c.text, c.outcome,
                  c.error, c.duration_ms, c.input_tokens
             FROM checks c LEFT JOIN projects p ON p.id = c.project_id
            ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY c.id DESC LIMIT ?`,
        )
        .all(...params, limitOf(filter.limit)) as {
        id: number;
        created_at: string;
        project: string | null;
        session_id: string | null;
        check_type: CheckType;
        text: string;
        outcome: Outcome;
        error: string | null;
        duration_ms: number;
        input_tokens: number | null;
      }[];

      const firingsOf = db.prepare(
        `SELECT f.rule_id, v.name, f.score, f.dropped
           FROM firings f LEFT JOIN versions v ON v.id = f.version_id
          WHERE f.check_id = ? ORDER BY f.score DESC, f.rule_id`,
      );
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        project: row.project,
        sessionId: row.session_id,
        checkType: row.check_type,
        text: row.text,
        outcome: row.outcome,
        error: row.error,
        durationMs: row.duration_ms,
        inputTokens: row.input_tokens,
        firings: (
          firingsOf.all(row.id) as { rule_id: number; name: string | null; score: number; dropped: number }[]
        ).map((f) => ({ ruleId: f.rule_id, name: f.name, score: f.score, dropped: f.dropped === 1 })),
      }));
    },

    ruleAnalytics(ruleId, options = {}) {
      requireRule(ruleId);
      // One read transaction, so every count and list comes from the same
      // snapshot even while a check is being written.
      db.exec("BEGIN");
      try {
        return readRuleAnalytics(db, ruleId, limitOf(options.limit));
      } finally {
        db.exec("COMMIT");
      }
    },
  };
}

function readRuleAnalytics(db: Store, ruleId: number, limit: number): RuleAnalytics {
  const versionsOfRule = "SELECT id FROM versions WHERE rule_id = ? AND number IS NOT NULL";

  const { checks } = db
    .prepare(`SELECT COUNT(DISTINCT check_id) AS checks FROM scores WHERE version_id IN (${versionsOfRule})`)
    .get(ruleId) as { checks: number };
  const counts = db
    .prepare(
      `SELECT COALESCE(SUM(dropped = 0), 0) AS firings, COALESCE(SUM(dropped = 1), 0) AS dropped
         FROM firings WHERE rule_id = ?`,
    )
    .get(ruleId) as { firings: number; dropped: number };

  const { wrongMatches } = db
    .prepare(
      `SELECT COUNT(*) AS wrongMatches FROM flags fl JOIN firings f ON f.id = fl.firing_id
        WHERE f.rule_id = ? AND fl.verdict = 'wrong'`,
    )
    .get(ruleId) as { wrongMatches: number };

  const recentFirings = (
    db
      .prepare(
        `SELECT f.id AS firing_id, f.check_id, c.created_at, p.name AS project, c.text, f.score, c.cutoff,
                v.number AS version_number, cond.text AS condition, f.dropped,
                fl.verdict, fl.raised_by, fl.created_at AS flagged_at
           FROM firings f
           JOIN checks c ON c.id = f.check_id
           LEFT JOIN projects p ON p.id = c.project_id
           LEFT JOIN versions v ON v.id = f.version_id
           LEFT JOIN conditions cond ON cond.id = f.condition_id
           LEFT JOIN flags fl ON fl.firing_id = f.id
          WHERE f.rule_id = ?
          ORDER BY f.check_id DESC LIMIT ?`,
      )
      .all(ruleId, limit) as (CheckViewRow & {
      firing_id: number;
      dropped: number;
      verdict: FlagView["verdict"] | null;
      raised_by: FlagView["raisedBy"] | null;
      flagged_at: string | null;
    })[]
  ).map((row) => ({
    ...checkView(row),
    firingId: row.firing_id,
    dropped: row.dropped === 1,
    flag:
      row.verdict && row.raised_by && row.flagged_at
        ? { verdict: row.verdict, raisedBy: row.raised_by, createdAt: row.flagged_at }
        : null,
  }));

  // The rule's best condition in each check it was scored in; a near miss
  // is a best score under that check's cutoff by no more than the margin.
  // (SQLite takes the bare columns from the row holding the MAX.)
  const nearMisses = (
    db
      .prepare(
        `SELECT best.check_id, c.created_at, p.name AS project, c.text, best.score, c.cutoff,
                v.number AS version_number, cond.text AS condition
           FROM (SELECT check_id, version_id, condition_id, MAX(score) AS score
                   FROM scores WHERE version_id IN (${versionsOfRule})
                  GROUP BY check_id) best
           JOIN checks c ON c.id = best.check_id
           LEFT JOIN projects p ON p.id = c.project_id
           LEFT JOIN versions v ON v.id = best.version_id
           LEFT JOIN conditions cond ON cond.id = best.condition_id
          WHERE best.score < c.cutoff AND best.score >= c.cutoff - ? - ?
          ORDER BY best.check_id DESC LIMIT ?`,
      )
      .all(ruleId, NEAR_MISS_MARGIN, EPSILON, limit) as CheckViewRow[]
  ).map(checkView);

  const versions = (
    db
      .prepare(
        `SELECT v.number, v.published_at,
                (SELECT COUNT(DISTINCT s.check_id) FROM scores s WHERE s.version_id = v.id) AS checks,
                (SELECT COUNT(*) FROM firings f
                  WHERE f.rule_id = v.rule_id AND f.version_id = v.id AND f.dropped = 0) AS firings,
                (SELECT COUNT(*) FROM flags fl JOIN firings f ON f.id = fl.firing_id
                  WHERE f.rule_id = v.rule_id AND f.version_id = v.id AND fl.verdict = 'wrong') AS wrong_matches
           FROM versions v
          WHERE v.rule_id = ? AND v.number IS NOT NULL
          ORDER BY v.number DESC`,
      )
      .all(ruleId) as { number: number; published_at: string; checks: number; firings: number; wrong_matches: number }[]
  ).map((row) => ({
    number: row.number,
    publishedAt: row.published_at,
    checks: row.checks,
    firings: row.firings,
    wrongMatches: row.wrong_matches,
  }));

  return {
    checks,
    firings: counts.firings,
    dropped: counts.dropped,
    wrongMatches,
    recentFirings,
    nearMisses,
    nearMissMargin: NEAR_MISS_MARGIN,
    versions,
  };
}
