import { cutToLastPart, splitIntoRequests, textTokenBudget } from "./limits.ts";
import { MalformedAnswerError, type Matcher, type MatcherCondition, type MatchResult } from "./matcher.ts";
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

export interface Match {
  ruleId: number;
  name: string;
  instruction: string;
  score: number;
}

export interface CheckResult {
  outcome: Outcome;
  /** The recorded check's id. */
  checkId: number;
  /** Matched rules, strongest first. Empty unless the outcome is attached or sent back. */
  matches: Match[];
  /** Why the check failed, in a few plain words for the user. Only when the outcome is failed. */
  failure?: string;
}

export interface EngineOptions {
  store: Store;
  rules: RulesService;
  /** Undefined when no API key is available: every check with live rules then fails. */
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

/** No matcher could be built, so a second try would fail the same way. */
class MissingApiKeyError extends Error {
  constructor() {
    super("missing API key");
  }
}

/**
 * The tokens of two tries of one check together. A try that never got an
 * answer used none; a count Jev did not report stays unknown.
 */
function addTokens(first: Tokens | undefined, second: Tokens | undefined): Tokens | undefined {
  if (!first || !second) return first ?? second;
  if (first.input === null || second.input === null) return { input: null, largestRequest: null };
  return {
    input: first.input + second.input,
    largestRequest: Math.max(first.largestRequest ?? 0, second.largestRequest ?? 0),
  };
}

/** A failed try, with the tokens Jev reported if it got that far. */
class FailedTry extends Error {
  readonly reason: unknown;
  readonly tokens: Tokens | undefined;
  constructor(reason: unknown, tokens?: Tokens) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.reason = reason;
    this.tokens = tokens;
  }
}

/** Why a check failed, in a few plain words for the user. */
function failureInWords(reason: unknown): string {
  if (reason instanceof MissingApiKeyError) return "no Jev API key is set";
  if (reason instanceof TimeoutError) return "Jev did not answer in time";
  if (reason instanceof MalformedAnswerError) return "Jev's answer could not be read";
  if (reason instanceof Error && /^Jev returned HTTP \d+$/.test(reason.message)) return reason.message;
  return "Jev could not be reached";
}

interface ScoreRow {
  rule: LiveRule;
  conditionId: number;
  score: number;
}

/** The input tokens Jev reported for a check: in all, and in its largest request. */
interface Tokens {
  input: number | null;
  largestRequest: number | null;
}

/** Adds up the requests' token counts; unknown if any request did not report one. */
function combineTokens(results: MatchResult[]): Tokens {
  const counts = results.map((r) => r.inputTokens);
  if (counts.some((count) => count === null)) return { input: null, largestRequest: null };
  const known = counts as number[];
  return { input: known.reduce((a, b) => a + b, 0), largestRequest: Math.max(...known) };
}

/** What one check records about itself, besides its scores and matches. */
interface CheckRecord {
  input: CheckInput;
  /** The text the check judged: the message after any slash command, cut to its last part if too long. */
  text: string;
  /** Whether the text was cut to fit Jev's per-question limit. */
  cut: boolean;
  /** The project the session's folder belongs to; undefined without a folder. */
  project: string | undefined;
  startedAt: number;
  cutoff: number;
}

/**
 * Runs checks: scores the live conditions of the check type against the
 * text, decides which rules match, and records everything. Scoring that
 * fails is tried once more; a check that still has no scores is recorded as
 * failed, and the hooks decide what that does to the turn.
 */
export function createEngine(options: EngineOptions): Engine {
  const { store, rules, matcher } = options;

  function record(
    check: CheckRecord,
    outcome: Outcome,
    extra: { error?: string; tokens?: Tokens; scores?: ScoreRow[]; matches?: ScoreRow[] } = {},
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
                               input_tokens, request_tokens, cut, cutoff, outcome, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createdAt,
          input.sessionId ?? null,
          input.cwd ?? null,
          projectId,
          input.checkType,
          check.text,
          durationMs,
          extra.tokens?.input ?? null,
          extra.tokens?.largestRequest ?? null,
          check.cut ? 1 : 0,
          check.cutoff,
          outcome,
          extra.error ?? null,
        );
      const addScore = store.prepare(
        "INSERT INTO scores (check_id, rule_id, version_id, condition_id, score) VALUES (?, ?, ?, ?, ?)",
      );
      for (const s of extra.scores ?? []) {
        addScore.run(checkId, s.rule.ruleId, s.rule.versionId, s.conditionId, s.score);
      }
      const addMatch = store.prepare(
        "INSERT INTO matches (check_id, rule_id, version_id, condition_id, score) VALUES (?, ?, ?, ?, ?)",
      );
      for (const f of extra.matches ?? []) {
        addMatch.run(checkId, f.rule.ruleId, f.rule.versionId, f.conditionId, f.score);
      }
      return Number(checkId);
    });
  }

  const projectOf = (input: CheckInput) => (input.cwd ? resolveProject(input.cwd) : undefined);

  /**
   * Scores the conditions against the text. When they would not fit one of
   * Jev's requests, they are split across parallel requests with the same
   * text, all inside the one time limit, and their scores are combined.
   */
  async function score(
    text: string,
    conditions: MatcherCondition[],
    timeLimitMs: number,
  ): Promise<{ scores: Record<string, number | undefined>; tokens: Tokens }> {
    if (!matcher) throw new MissingApiKeyError();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeLimitMs));
      }, timeLimitMs);
    });
    try {
      const parts = splitIntoRequests(text, conditions);
      const results = await Promise.race([
        Promise.all(parts.map((part) => matcher.match(text, part, controller.signal))),
        timeout,
      ]);
      // Each request is read only for the conditions it carried.
      const scores: Record<string, number | undefined> = {};
      parts.forEach((part, index) => {
        for (const { id } of part) scores[id] = results[index]!.scores[id];
      });
      return { scores, tokens: combineTokens(results) };
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    skip(input) {
      const startedAt = performance.now();
      const { cutoff } = rules.settings();
      return record(
        { input, text: input.text, cut: false, project: projectOf(input), startedAt, cutoff },
        "skipped",
      );
    },

    async check(input) {
      const startedAt = performance.now();
      const { cutoff, timeLimitMs } = rules.settings();
      const project = projectOf(input);

      // A message that starts with a slash command is judged only on what follows the command name.
      const judged = input.checkType === "message" ? messageText(input.text) : { kind: "check" as const, text: input.text };
      if (judged.kind === "skip") {
        const checkId = record({ input, text: input.text, cut: false, project, startedAt, cutoff }, "skipped");
        return { outcome: "skipped", checkId, matches: [] };
      }
      // Only the rules in scope for this project reach the matcher.
      const live = rules.liveRules(input.checkType, project);

      const sent = new Map<string, { rule: LiveRule; conditionId: number }>();
      for (const rule of live) {
        for (const condition of rule.conditions) sent.set(`c${condition.id}`, { rule, conditionId: condition.id });
      }
      // Email addresses never leave the machine: they are masked in the text and in the conditions.
      const conditions = live.flatMap((rule) =>
        rule.conditions.map((c) => ({ id: `c${c.id}`, text: maskEmails(c.text) })),
      );

      // A text too long for Jev's per-question limit is cut to its last part, and the cut is recorded.
      const { text, cut } = cutToLastPart(judged.text, textTokenBudget(conditions));
      const check: CheckRecord = { input, text, cut, project, startedAt, cutoff };
      // With no live rule there is nothing to ask Jev, and the answer is known: no rule matched.
      if (live.length === 0) {
        return { outcome: "nothing", checkId: record(check, "nothing"), matches: [] };
      }

      /** One try at getting a valid score for every condition sent. */
      const tryScoring = async (): Promise<{ scores: ScoreRow[]; tokens: Tokens }> => {
        let result;
        try {
          result = await score(maskEmails(text), conditions, timeLimitMs);
        } catch (error) {
          throw new FailedTry(error);
        }
        // Read answers only for the IDs that were sent; every one must be a score from 0 to 1.
        const scores: ScoreRow[] = [];
        for (const [id, { rule, conditionId }] of sent) {
          const value = result.scores[id];
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new FailedTry(new MalformedAnswerError(`no valid score for ${id}`), result.tokens);
          }
          scores.push({ rule, conditionId, score: value });
        }
        return { scores, tokens: result.tokens };
      };

      // A network error, a timeout or an unreadable answer may not happen twice, so scoring
      // is tried once more, with the full time limit again. A missing API key is not retried.
      let result;
      let firstError: string | undefined;
      let firstTokens: Tokens | undefined;
      for (;;) {
        try {
          result = await tryScoring();
          break;
        } catch (error) {
          const failedTry = error as FailedTry;
          if (firstError === undefined && !(failedTry.reason instanceof MissingApiKeyError)) {
            firstError = failedTry.message;
            firstTokens = failedTry.tokens;
            continue;
          }
          const retried = firstError === undefined ? "" : ` (second try; the first failed: ${firstError})`;
          const checkId = record(check, "failed", {
            error: failedTry.message + retried,
            tokens: addTokens(firstTokens, failedTry.tokens),
          });
          return { outcome: "failed", checkId, matches: [], failure: failureInWords(failedTry.reason) };
        }
      }
      const { scores } = result;
      const tokens = addTokens(firstTokens, result.tokens);

      // A rule matches when any one of its conditions reaches the cutoff; its best condition stands for it.
      const best = new Map<number, ScoreRow>();
      for (const row of scores) {
        const current = best.get(row.rule.ruleId);
        if (!current || row.score > current.score) best.set(row.rule.ruleId, row);
      }
      // Every rule that matches is attached or sent back, strongest first.
      const matched = [...best.values()]
        .filter((row) => row.score >= cutoff)
        .sort((a, b) => b.score - a.score || a.rule.ruleId - b.rule.ruleId);

      const outcome: Outcome = matched.length === 0 ? "nothing" : input.checkType === "message" ? "attached" : "sent_back";
      const checkId = record(check, outcome, { tokens, scores, matches: matched });
      return {
        outcome,
        checkId,
        matches: matched.map((row) => ({
          ruleId: row.rule.ruleId,
          name: row.rule.name,
          instruction: row.rule.instruction,
          score: row.score,
        })),
      };
    },
  };
}
