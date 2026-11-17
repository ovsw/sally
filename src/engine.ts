import { MalformedAnswerError, type Matcher, type MatcherCondition } from "./matcher.ts";
import { resolveProject } from "./project.ts";
import type { CheckType, LiveRule, RulesService } from "./rules.ts";
import { type Store, transaction } from "./store.ts";
import { maskEmails, messageText } from "./text.ts";

export type Outcome = "nothing" | "attached" | "sent_back" | "skipped" | "failed";

export interface CheckInput {
  checkType: CheckType;
  text: string;
  sessionId?: string;
  cwd?: string;
}

export interface Firing {
  ruleId: number;
  name: string;
  instruction: string;
  score: number;
}

export interface CheckResult {
  outcome: Outcome;
  /** The recorded check's id. */
  checkId: number;
  /** Fired rules, strongest first. Empty unless the outcome is attached or sent back. */
  firings: Firing[];
}

export interface EngineOptions {
  store: Store;
  rules: RulesService;
  /** Undefined when no API key is available: every check then fails open. */
  matcher: Matcher | undefined;
}

export interface Engine {
  check(input: CheckInput): Promise<CheckResult>;
  /** Records a check that was skipped without asking the matcher, and returns its id. */
  skip(input: CheckInput): number;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
  }
}

interface ScoreRow {
  rule: LiveRule;
  conditionId: number;
  score: number;
}

interface FiringRow extends ScoreRow {
  dropped: boolean;
}

/** What one check records about itself, besides its scores and firings. */
interface CheckRecord {
  input: CheckInput;
  /** The text the check judged: the message after any slash command. */
  text: string;
  /** The project the session's folder belongs to; undefined without a folder. */
  project: string | undefined;
  startedAt: number;
  cutoff: number;
  cap: number;
}

/**
 * Runs checks: scores the live conditions of the check type against the
 * text, decides which rules fire, and records everything. Any failure
 * leaves the turn untouched.
 */
export function createEngine(options: EngineOptions): Engine {
  const { store, rules, matcher } = options;

  function record(
    check: CheckRecord,
    outcome: Outcome,
    extra: { error?: string; inputTokens?: number | null; scores?: ScoreRow[]; firings?: FiringRow[] } = {},
  ): number {
    const { input } = check;
    const durationMs = Math.round(performance.now() - check.startedAt);
    return transaction(store, () => {
      const createdAt = new Date().toISOString();
      let projectId: number | null = null;
      if (check.project !== undefined) {
        // A project is recorded the first time a check runs in it.
        store
          .prepare("INSERT INTO projects (name, first_seen_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING")
          .run(check.project, createdAt);
        projectId = (store.prepare("SELECT id FROM projects WHERE name = ?").get(check.project) as { id: number }).id;
      }
      const { lastInsertRowid: checkId } = store
        .prepare(
          `INSERT INTO checks (created_at, session_id, cwd, project_id, check_type, text, duration_ms,
                               input_tokens, cutoff, cap, outcome, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createdAt,
          input.sessionId ?? null,
          input.cwd ?? null,
          projectId,
          input.checkType,
          check.text,
          durationMs,
          extra.inputTokens ?? null,
          check.cutoff,
          check.cap,
          outcome,
          extra.error ?? null,
        );
      const addScore = store.prepare(
        "INSERT INTO scores (check_id, rule_id, version_id, condition_id, score) VALUES (?, ?, ?, ?, ?)",
      );
      for (const s of extra.scores ?? []) {
        addScore.run(checkId, s.rule.ruleId, s.rule.versionId, s.conditionId, s.score);
      }
      const addFiring = store.prepare(
        `INSERT INTO firings (check_id, rule_id, version_id, condition_id, score, dropped)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const f of extra.firings ?? []) {
        addFiring.run(checkId, f.rule.ruleId, f.rule.versionId, f.conditionId, f.score, f.dropped ? 1 : 0);
      }
      return Number(checkId);
    });
  }

  const projectOf = (input: CheckInput) => (input.cwd ? resolveProject(input.cwd) : undefined);

  async function score(text: string, conditions: MatcherCondition[], timeLimitMs: number) {
    if (!matcher) throw new Error("missing API key");
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeLimitMs));
      }, timeLimitMs);
    });
    try {
      return await Promise.race([matcher.match(text, conditions, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    skip(input) {
      const startedAt = performance.now();
      const { cutoff, cap } = rules.settings();
      return record({ input, text: input.text, project: projectOf(input), startedAt, cutoff, cap }, "skipped");
    },

    async check(input) {
      const startedAt = performance.now();
      const { cutoff, cap, timeLimitMs } = rules.settings();
      const project = projectOf(input);

      // A message that starts with a slash command is judged only on what follows the command name.
      const judged = input.checkType === "message" ? messageText(input.text) : { kind: "check" as const, text: input.text };
      if (judged.kind === "skip") {
        const checkId = record({ input, text: input.text, project, startedAt, cutoff, cap }, "skipped");
        return { outcome: "skipped", checkId, firings: [] };
      }
      const check: CheckRecord = { input, text: judged.text, project, startedAt, cutoff, cap };
      const failed = (error: string, inputTokens?: number | null): CheckResult => {
        const checkId = record(check, "failed", { error, inputTokens });
        return { outcome: "failed", checkId, firings: [] };
      };

      // Only the rules in scope for this project reach the matcher.
      const live = rules.liveRules(input.checkType, project);
      if (live.length === 0) return failed("no live rules");

      const sent = new Map<string, { rule: LiveRule; conditionId: number }>();
      for (const rule of live) {
        for (const condition of rule.conditions) sent.set(`c${condition.id}`, { rule, conditionId: condition.id });
      }
      // Email addresses never leave the machine: they are masked in the text and in the conditions.
      const conditions = live.flatMap((rule) =>
        rule.conditions.map((c) => ({ id: `c${c.id}`, text: maskEmails(c.text) })),
      );

      let result;
      try {
        result = await score(maskEmails(check.text), conditions, timeLimitMs);
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }

      // Read answers only for the IDs that were sent; every one must be a score from 0 to 1.
      const scores: ScoreRow[] = [];
      for (const [id, { rule, conditionId }] of sent) {
        const value = result.scores[id];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          return failed(new MalformedAnswerError(`no valid score for ${id}`).message, result.inputTokens);
        }
        scores.push({ rule, conditionId, score: value });
      }

      // A rule fires when any one of its conditions reaches the cutoff; its best condition stands for it.
      const best = new Map<number, ScoreRow>();
      for (const row of scores) {
        const current = best.get(row.rule.ruleId);
        if (!current || row.score > current.score) best.set(row.rule.ruleId, row);
      }
      // Strongest first; the cap keeps the strongest and the rest are recorded as dropped.
      const fired: FiringRow[] = [...best.values()]
        .filter((row) => row.score >= cutoff)
        .sort((a, b) => b.score - a.score || a.rule.ruleId - b.rule.ruleId)
        .map((row, index) => ({ ...row, dropped: index >= cap }));
      const kept = fired.filter((row) => !row.dropped);

      const outcome: Outcome = kept.length === 0 ? "nothing" : input.checkType === "message" ? "attached" : "sent_back";
      const checkId = record(check, outcome, { inputTokens: result.inputTokens, scores, firings: fired });
      return {
        outcome,
        checkId,
        firings: kept.map((row) => ({
          ruleId: row.rule.ruleId,
          name: row.rule.name,
          instruction: row.rule.instruction,
          score: row.score,
        })),
      };
    },
  };
}
