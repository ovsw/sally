import type { CheckType, Settings } from "./rules.ts";
import type { Store } from "./store.ts";

/** Slack for float rounding, so a score exactly the margin above the cutoff still counts as a weak match. */
const EPSILON = 1e-9;

/**
 * Why a rule needs attention, worst first:
 *
 * - false_positives: matches of its live version were marked as false positives.
 * - matches_often: it matched on a large share of its recent checks.
 * - weak_matches: some of its recent matches scored only just above the cutoff.
 * - never_matches: it has not matched over a long stretch of checks.
 */
export type AttentionKind = "false_positives" | "matches_often" | "weak_matches" | "never_matches";

/** The reasons the user can clear with "Looks fine". False positives are cleared by fixing the rule. */
export const CLEARABLE_KINDS: readonly AttentionKind[] = ["matches_often", "weak_matches", "never_matches"];

const KIND_ORDER: readonly AttentionKind[] = ["false_positives", "matches_often", "weak_matches", "never_matches"];

export type AttentionReason = { summary: string } & (
  | { kind: "false_positives"; falsePositives: number }
  | { kind: "matches_often"; matches: number; checks: number; share: number; threshold: number }
  | { kind: "weak_matches"; weakMatches: number; matches: number; margin: number }
  | { kind: "never_matches"; checks: number }
);

/** A rule on the Needs attention list, with every reason it is there. */
export interface AttentionEntry {
  ruleId: number;
  name: string;
  /** The check types the rule takes part in: those its live conditions are on for. */
  checkTypes: CheckType[];
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
 * A reason the user cleared for the live version is left out.
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
      `SELECT r.id, r.name, v.id AS version_id, v.number,
              EXISTS (SELECT 1 FROM version_conditions vc JOIN conditions c ON c.id = vc.condition_id
                       WHERE vc.version_id = v.id AND c.message = 1) AS in_message,
              EXISTS (SELECT 1 FROM version_conditions vc JOIN conditions c ON c.id = vc.condition_id
                       WHERE vc.version_id = v.id AND c.reply = 1) AS in_reply
         FROM rules r
         JOIN versions v ON v.rule_id = r.id
                        AND v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id)
        WHERE r.switched_off = 0`,
    )
    .all() as { id: number; name: string; version_id: number; number: number; in_message: number; in_reply: number }[];

  // The latest checks a version was scored in, and its matches in them.
  const latest = `SELECT DISTINCT check_id FROM scores WHERE version_id = :version ORDER BY check_id DESC LIMIT :limit`;
  const window = db.prepare(
    `WITH latest AS (${latest})
     SELECT (SELECT COUNT(*) FROM latest) AS checks,
            COUNT(f.id) AS matches,
            COALESCE(SUM(f.score < c.cutoff + :margin + :epsilon), 0) AS weak
       FROM matches f JOIN checks c ON c.id = f.check_id
      WHERE f.version_id = :version AND f.check_id IN (SELECT check_id FROM latest)`,
  );

  const falsePositiveCount = db.prepare(
    `SELECT COUNT(*) AS count FROM false_positives fp JOIN matches f ON f.id = fp.match_id WHERE f.version_id = ?`,
  );

  const clearedKinds = db.prepare("SELECT kind FROM cleared_reasons WHERE version_id = ?");

  const entries: AttentionEntry[] = [];
  for (const rule of rules) {
    const found: AttentionReason[] = [];

    const falsePositives = (falsePositiveCount.get(rule.version_id) as { count: number }).count;
    if (falsePositives > 0) {
      found.push({
        kind: "false_positives",
        falsePositives,
        summary: `${falsePositives} ${falsePositives === 1 ? "false positive" : "false positives"} on version ${rule.number}.`,
      });
    }

    const recent = window.get({
      version: rule.version_id,
      limit: t.recentChecks,
      margin: t.closeMargin,
      epsilon: EPSILON,
    }) as { checks: number; matches: number; weak: number };
    if (recent.checks > 0 && recent.matches / recent.checks >= t.busyShare - EPSILON) {
      const share = recent.matches / recent.checks;
      found.push({
        kind: "matches_often",
        matches: recent.matches,
        checks: recent.checks,
        share,
        threshold: t.busyShare,
        summary: `Matched on ${recent.matches} of its last ${plural(recent.checks, "check")} (${percent(share)}); the threshold is ${percent(t.busyShare)}.`,
      });
    }
    if (recent.weak > 0) {
      found.push({
        kind: "weak_matches",
        weakMatches: recent.weak,
        matches: recent.matches,
        margin: t.closeMargin,
        summary: `${recent.matches === 1 ? "Its only recent match" : `${recent.weak} of its ${recent.matches} recent matches`} scored no more than ${t.closeMargin} above the cutoff.`,
      });
    }

    const stretch = window.get({
      version: rule.version_id,
      limit: t.quietChecks,
      margin: 0,
      epsilon: 0,
    }) as { checks: number; matches: number };
    if (stretch.checks >= t.quietChecks && stretch.matches === 0) {
      found.push({
        kind: "never_matches",
        checks: stretch.checks,
        summary: `No matches in its last ${plural(stretch.checks, "check")}.`,
      });
    }

    const cleared = new Set((clearedKinds.all(rule.version_id) as { kind: string }[]).map((row) => row.kind));
    const reasons = found.filter((reason) => !cleared.has(reason.kind));

    if (reasons.length > 0) {
      entries.push({
        ruleId: rule.id,
        name: rule.name,
        checkTypes: (["message", "reply"] as const).filter((type) => (type === "message" ? rule.in_message : rule.in_reply) === 1),
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
