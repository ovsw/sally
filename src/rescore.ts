import type { FalsePositive } from "./false-positives.ts";
import { MalformedAnswerError, type Matcher } from "./matcher.ts";
import type { CheckType, Switches } from "./rules.ts";
import { maskEmails } from "./text.ts";

/** How long a re-score may wait for Jev, for all of a rule's false positives together. */
export const RESCORE_TIME_LIMIT_MS = 20_000;

/** How many false positives are sent to Jev at once. */
const PARALLEL_REQUESTS = 4;

/** How one false positive fares against the draft's conditions for its check type. */
export interface FalsePositiveResult {
  falsePositive: FalsePositive;
  /**
   * Each of the draft's conditions on for the false positive's check type,
   * with its score on its text, in the draft's order. Empty when the draft has
   * no condition on for that check type.
   */
  scores: { condition: string; score: number }[];
  /** The best of those scores; null when there are none. */
  best: number | null;
  /** The cutoff of the false positive's check type. */
  cutoff: number;
  /** Whether the draft would still match it: a condition reaches the cutoff. */
  matched: boolean;
  /** Whether the draft no longer matches it. */
  passed: boolean;
}

/** The cutoff of each check type. */
export type Cutoffs = Record<CheckType, number>;

/**
 * A draft's conditions scored against its rule's false positives.
 * "no_false_positives" when the rule has none (nothing is sent to Jev);
 * "failed" when Jev could not score them, with the reason in `error`. A
 * failure never blocks publishing.
 */
export type RescoreResult =
  | { status: "scored"; cutoffs: Cutoffs; results: FalsePositiveResult[]; passed: number; failed: number }
  | { status: "no_false_positives"; cutoffs: Cutoffs }
  | { status: "failed"; cutoffs: Cutoffs; error: string; count: number };

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
  }
}

/**
 * Scores each false positive's text against the conditions on for its check
 * type, one request each, and says which the draft no longer matches at that
 * check type's cutoff. One whose check type no condition is on for is not
 * sent: the rule would not match it. Email addresses are masked in everything
 * sent. `matcher` is undefined when there is no API key.
 */
export async function rescoreFalsePositives(options: {
  matcher: Matcher | undefined;
  conditions: (Switches & { text: string })[];
  falsePositives: FalsePositive[];
  cutoffs: Cutoffs;
  timeLimitMs?: number;
}): Promise<RescoreResult> {
  const { matcher, conditions, falsePositives, cutoffs, timeLimitMs = RESCORE_TIME_LIMIT_MS } = options;
  if (falsePositives.length === 0) return { status: "no_false_positives", cutoffs };
  const failed = (error: string): RescoreResult => ({ status: "failed", cutoffs, error, count: falsePositives.length });
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

  async function scoreOne(falsePositive: FalsePositive): Promise<FalsePositiveResult> {
    const cutoff = cutoffs[falsePositive.checkType];
    const forCheck = sent.filter((condition) => condition[falsePositive.checkType]);
    const outcome = (scores: FalsePositiveResult["scores"]): FalsePositiveResult => {
      const best = scores.length > 0 ? Math.max(...scores.map((s) => s.score)) : null;
      const matched = best !== null && best >= cutoff;
      return { falsePositive, scores, best, cutoff, matched, passed: !matched };
    };
    if (forCheck.length === 0) return outcome([]);
    const result = await matcher!.match(
      maskEmails(falsePositive.text),
      forCheck.map(({ id, text }) => ({ id, text })),
      controller.signal,
    );
    // Read answers only for the IDs that were sent; every one must be a score from 0 to 1.
    return outcome(
      forCheck.map(({ id, written }) => {
        const value = result.scores[id];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new MalformedAnswerError(`no valid score for ${id}`);
        }
        return { condition: written, score: value };
      }),
    );
  }

  async function scoreAll(): Promise<FalsePositiveResult[]> {
    const results: FalsePositiveResult[] = new Array(falsePositives.length);
    let next = 0;
    const worker = async () => {
      while (next < falsePositives.length && !controller.signal.aborted) {
        const index = next++;
        results[index] = await scoreOne(falsePositives[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, falsePositives.length) }, worker));
    return results;
  }

  try {
    const results = await Promise.race([scoreAll(), timeout]);
    const passed = results.filter((r) => r.passed).length;
    return { status: "scored", cutoffs, results, passed, failed: results.length - passed };
  } catch (error) {
    // The other requests have no use once one has failed.
    controller.abort();
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
