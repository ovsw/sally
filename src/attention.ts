import type { CheckType, Settings } from "./rules.ts";
import type { Store } from "./store.ts";

/** Slack for float rounding, so a score exactly the margin above the cutoff still counts as close. */
const EPSILON = 1e-9;

/**
 * Why a rule needs attention, worst first:
 *
 * - wrong_matches: firings of its live version were flagged as wrong matches.
 * - fires_often: it fired on a large share of its recent checks.
 * - close_to_cutoff: some of its recent firings scored only just above the cutoff.
 * - never_fires: it has not fired over a long stretch of checks.
 */
export type AttentionKind = "wrong_matches" | "fires_often" | "close_to_cutoff" | "never_fires";

const KIND_ORDER: readonly AttentionKind[] = ["wrong_matches", "fires_often", "close_to_cutoff", "never_fires"];

export type AttentionReason = { summary: string } & (
  | { kind: "wrong_matches"; flags: number }
  | { kind: "fires_often"; firings: number; checks: number; share: number; threshold: number }
  | { kind: "close_to_cutoff"; closeFirings: number; firings: number; margin: number }
  | { kind: "never_fires"; checks: number }
);

/** A rule on the Needs attention list, with every reason it is there. */
export interface AttentionEntry {
  ruleId: number;
  name: string;
  checkType: CheckType;
  /** The live version the reasons are about. */
  versionNumber: number;
  /** Worst first. */
  reasons: AttentionReason[];
}

type Thresholds = Pick<Settings, "recentChecks" | "busyShare" | "closeMargin" | "quietChecks">;

const percent = (share: number) => `${Math.round(share * 100)}%`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The rules that need the user's attention, worst first. Only rules that are
 * live and on are listed, and only their live version counts: publishing a
 * new version starts its record afresh, so a rewording gets a fair chance.
 * "Recent" and "a long stretch" are the latest checks the live version was
 * scored in, so a rule scoped to one project is judged on that project's checks.
 */
export function attentionList(db: Store, thresholds: Thresholds): AttentionEntry[] {
  // One read transaction, so every count comes from the same snapshot even
  // while a check is being written.
  db.exec("BEGIN");
  try {
    return readAttention(db, thresholds);
  } finally {
    db.exec("COMMIT");
  }
}

function readAttention(db: Store, t: Thresholds): AttentionEntry[] {
  const rules = db
    .prepare(
      `SELECT r.id, r.name, r.check_type, v.id AS version_id, v.number
         FROM rules r
         JOIN versions v ON v.rule_id = r.id
                        AND v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id)
        WHERE r.switched_off = 0`,
    )
    .all() as { id: number; name: string; check_type: CheckType; version_id: number; number: number }[];

  // The latest checks a version was scored in, and its firings in them.
  const latest = `SELECT DISTINCT check_id FROM scores WHERE version_id = :version ORDER BY check_id DESC LIMIT :limit`;
  const window = db.prepare(
    `WITH latest AS (${latest})
     SELECT (SELECT COUNT(*) FROM latest) AS checks,
            COUNT(f.id) AS firings,
            COALESCE(SUM(f.score < c.cutoff + :margin + :epsilon), 0) AS close
       FROM firings f JOIN checks c ON c.id = f.check_id
      WHERE f.version_id = :version AND f.check_id IN (SELECT check_id FROM latest)`,
  );

  // Wrong-match flags come with the flags table; a database without one has none.
  const hasFlags = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flags'").get() !== undefined;
  const wrongFlags = hasFlags
    ? db.prepare(
        `SELECT COUNT(*) AS flags FROM flags fl JOIN firings f ON f.id = fl.firing_id
          WHERE f.version_id = ? AND fl.verdict = 'wrong'`,
      )
    : undefined;

  const entries: AttentionEntry[] = [];
  for (const rule of rules) {
    const reasons: AttentionReason[] = [];

    const flags = wrongFlags ? (wrongFlags.get(rule.version_id) as { flags: number }).flags : 0;
    if (flags > 0) {
      reasons.push({
        kind: "wrong_matches",
        flags,
        summary: `${plural(flags, "firing")} of version ${rule.number} flagged as a wrong match.`,
      });
    }

    const recent = window.get({
      version: rule.version_id,
      limit: t.recentChecks,
      margin: t.closeMargin,
      epsilon: EPSILON,
    }) as { checks: number; firings: number; close: number };
    if (recent.checks > 0 && recent.firings / recent.checks >= t.busyShare - EPSILON) {
      const share = recent.firings / recent.checks;
      reasons.push({
        kind: "fires_often",
        firings: recent.firings,
        checks: recent.checks,
        share,
        threshold: t.busyShare,
        summary: `Fired on ${recent.firings} of its last ${plural(recent.checks, "check")} (${percent(share)}); the threshold is ${percent(t.busyShare)}.`,
      });
    }
    if (recent.close > 0) {
      reasons.push({
        kind: "close_to_cutoff",
        closeFirings: recent.close,
        firings: recent.firings,
        margin: t.closeMargin,
        summary: `${recent.firings === 1 ? "Its only recent firing" : `${recent.close} of its ${recent.firings} recent firings`} scored no more than ${t.closeMargin} above the cutoff.`,
      });
    }

    const stretch = window.get({
      version: rule.version_id,
      limit: t.quietChecks,
      margin: 0,
      epsilon: 0,
    }) as { checks: number; firings: number };
    if (stretch.checks >= t.quietChecks && stretch.firings === 0) {
      reasons.push({
        kind: "never_fires",
        checks: stretch.checks,
        summary: `No firings in its last ${plural(stretch.checks, "check")}.`,
      });
    }

    if (reasons.length > 0) {
      entries.push({
        ruleId: rule.id,
        name: rule.name,
        checkType: rule.check_type,
        versionNumber: rule.number,
        reasons,
      });
    }
  }

  const worst = (entry: AttentionEntry) => KIND_ORDER.indexOf(entry.reasons[0]!.kind);
  return entries.sort(
    (a, b) => worst(a) - worst(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.ruleId - b.ruleId,
  );
}
