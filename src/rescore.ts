import type { SavedCaseView } from "./flags.ts";
import { MalformedAnswerError, type Matcher } from "./matcher.ts";
import type { CheckType, Switches } from "./rules.ts";
import { maskEmails } from "./text.ts";

/** How long a re-score may wait for Jev, for all of a rule's saved cases together. */
export const RESCORE_TIME_LIMIT_MS = 20_000;

/** How many saved cases are sent to Jev at once. */
const PARALLEL_REQUESTS = 4;

/** How one saved case fares against the draft's conditions for its check type. */
export interface CaseResult {
  case: SavedCaseView;
  /**
   * Each of the draft's conditions on for the case's check type, with its score
   * on the case's text, in the draft's order. Empty when the draft has no
   * condition on for that check type.
   */
  scores: { condition: string; score: number }[];
  /** The best of those scores; null when there are none. */
  best: number | null;
  /** The cutoff of the case's check type. */
  cutoff: number;
  /** Whether the rule would match the case: a condition reaches the cutoff. */
  matched: boolean;
  /** Whether that is what the case expects. */
  passed: boolean;
}

/** The cutoff of each check type. */
export type Cutoffs = Record<CheckType, number>;

/**
 * A draft's conditions scored against its rule's saved cases. "no_cases" when
 * the rule has none (nothing is sent to Jev); "failed" when Jev could not
 * score them, with the reason in `error`. A failure never blocks publishing.
 */
export type RescoreResult =
  | { status: "scored"; cutoffs: Cutoffs; cases: CaseResult[]; passed: number; failed: number }
  | { status: "no_cases"; cutoffs: Cutoffs }
  | { status: "failed"; cutoffs: Cutoffs; error: string; caseCount: number };

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
  }
}

/**
 * Scores each saved case's text against the conditions on for the case's
 * check type, one request per case, and says which cases pass at that check
 * type's cutoff. A case whose check type no condition is on for is not sent:
 * the rule would not match it. Email addresses are masked in everything sent.
 * `matcher` is undefined when there is no API key.
 */
export async function rescoreCases(options: {
  matcher: Matcher | undefined;
  conditions: (Switches & { text: string })[];
  cases: SavedCaseView[];
  cutoffs: Cutoffs;
  timeLimitMs?: number;
}): Promise<RescoreResult> {
  const { matcher, conditions, cases, cutoffs, timeLimitMs = RESCORE_TIME_LIMIT_MS } = options;
  if (cases.length === 0) return { status: "no_cases", cutoffs };
  const failed = (error: string): RescoreResult => ({ status: "failed", cutoffs, error, caseCount: cases.length });
  if (!matcher) return failed("missing API key");

  const sent = conditions.map((condition, index) => ({
    id: `c${index}`,
    text: maskEmails(condition.text),
    written: condition.text,
    message: condition.message,
    reply: condition.reply,
  }));
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeLimitMs));
    }, timeLimitMs);
  });

  async function scoreCase(savedCase: SavedCaseView): Promise<CaseResult> {
    const cutoff = cutoffs[savedCase.checkType];
    const forCase = sent.filter((condition) => condition[savedCase.checkType]);
    const outcome = (scores: CaseResult["scores"]): CaseResult => {
      const best = scores.length > 0 ? Math.max(...scores.map((s) => s.score)) : null;
      const matched = best !== null && best >= cutoff;
      return { case: savedCase, scores, best, cutoff, matched, passed: matched === (savedCase.expected === "should_match") };
    };
    if (forCase.length === 0) return outcome([]);
    const result = await matcher!.match(
      maskEmails(savedCase.text),
      forCase.map(({ id, text }) => ({ id, text })),
      controller.signal,
    );
    // Read answers only for the IDs that were sent; every one must be a score from 0 to 1.
    return outcome(
      forCase.map(({ id, written }) => {
        const value = result.scores[id];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new MalformedAnswerError(`no valid score for ${id}`);
        }
        return { condition: written, score: value };
      }),
    );
  }

  async function scoreAll(): Promise<CaseResult[]> {
    const results: CaseResult[] = new Array(cases.length);
    let next = 0;
    const worker = async () => {
      while (next < cases.length && !controller.signal.aborted) {
        const index = next++;
        results[index] = await scoreCase(cases[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, cases.length) }, worker));
    return results;
  }

  try {
    const results = await Promise.race([scoreAll(), timeout]);
    const passed = results.filter((r) => r.passed).length;
    return { status: "scored", cutoffs, cases: results, passed, failed: results.length - passed };
  } catch (error) {
    // The other requests have no use once one has failed.
    controller.abort();
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
