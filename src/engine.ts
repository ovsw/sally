import { MalformedAnswerError, type Matcher, type MatcherCondition } from "./matcher.ts";
import type { CheckType, LiveRule, RulesService } from "./rules.ts";
import { type Store, transaction } from "./store.ts";

export const DEFAULT_CUTOFF = 0.6;
export const DEFAULT_TIME_LIMIT_MS = 3000;

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
  cutoff?: number;
  timeLimitMs?: number;
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

/**
 * Runs checks: scores the live conditions of the check type against the
 * text, decides which rules fire, and records everything. Any failure
 * leaves the turn untouched.
 */
export function createEngine(options: EngineOptions): Engine {
  const { store, rules, matcher } = options;
  const cutoff = options.cutoff ?? DEFAULT_CUTOFF;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;

  function record(
    input: CheckInput,
    startedAt: number,
    outcome: Outcome,
    extra: { error?: string; inputTokens?: number | null; scores?: ScoreRow[]; firings?: ScoreRow[] } = {},
  ): number {
    const durationMs = Math.round(performance.now() - startedAt);
    return transaction(store, () => {
      const { lastInsertRowid: checkId } = store
        .prepare(
          `INSERT INTO checks (created_at, session_id, cwd, check_type, text, duration_ms,
                               input_tokens, cutoff, outcome, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          new Date().toISOString(),
          input.sessionId ?? null,
          input.cwd ?? null,
          input.checkType,
          input.text,
          durationMs,
          extra.inputTokens ?? null,
          cutoff,
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
        "INSERT INTO firings (check_id, rule_id, version_id, condition_id, score) VALUES (?, ?, ?, ?, ?)",
      );
      for (const f of extra.firings ?? []) {
        addFiring.run(checkId, f.rule.ruleId, f.rule.versionId, f.conditionId, f.score);
      }
      return Number(checkId);
    });
  }

  async function score(text: string, conditions: MatcherCondition[]) {
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
      return record(input, performance.now(), "skipped");
    },

    async check(input) {
      const startedAt = performance.now();
      const failed = (error: string, inputTokens?: number | null): CheckResult => {
        const checkId = record(input, startedAt, "failed", { error, inputTokens });
        return { outcome: "failed", checkId, firings: [] };
      };

      const live = rules.liveRules(input.checkType);
      if (live.length === 0) return failed("no live rules");

      const sent = new Map<string, { rule: LiveRule; conditionId: number }>();
      for (const rule of live) {
        for (const condition of rule.conditions) sent.set(`c${condition.id}`, { rule, conditionId: condition.id });
      }
      const conditions = live.flatMap((rule) => rule.conditions.map((c) => ({ id: `c${c.id}`, text: c.text })));

      let result;
      try {
        result = await score(input.text, conditions);
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
      const fired = [...best.values()].filter((row) => row.score >= cutoff).sort((a, b) => b.score - a.score);

      const outcome: Outcome = fired.length === 0 ? "nothing" : input.checkType === "message" ? "attached" : "sent_back";
      const checkId = record(input, startedAt, outcome, { inputTokens: result.inputTokens, scores, firings: fired });
      return {
        outcome,
        checkId,
        firings: fired.map((row) => ({
          ruleId: row.rule.ruleId,
          name: row.rule.name,
          instruction: row.rule.instruction,
          score: row.score,
        })),
      };
    },
  };
}
