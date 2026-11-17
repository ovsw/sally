import type { SavedCaseView } from "./flags.ts";
import { MalformedAnswerError, type Matcher } from "./matcher.ts";
import { maskEmails } from "./text.ts";

/** How long a re-score may wait for Jev, for all of a rule's saved cases together. */
export const RESCORE_TIME_LIMIT_MS = 20_000;

/** How many saved cases are sent to Jev at once. */
const PARALLEL_REQUESTS = 4;

/** How one saved case fares against the draft's conditions. */
export interface CaseResult {
  case: SavedCaseView;
  /** Each of the draft's conditions with its score on the case's text, in the draft's order. */
  scores: { condition: string; score: number }[];
  /** The best of those scores. */
  best: number;
  /** Whether the rule would match the case: a condition reaches the cutoff. */
  matched: boolean;
  /** Whether that is what the case expects. */
  passed: boolean;
}

/**
 * A draft's conditions scored against its rule's saved cases. "no_cases" when
 * the rule has none (nothing is sent to Jev); "failed" when Jev could not
 * score them, with the reason in `error`. A failure never blocks publishing.
 */
export type RescoreResult =
  | { status: "scored"; cutoff: number; cases: CaseResult[]; passed: number; failed: number }
  | { status: "no_cases"; cutoff: number }
  | { status: "failed"; cutoff: number; error: string; caseCount: number };

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
  }
}

/**
 * Scores the conditions against each saved case's text with the matcher, one
 * request per case, and says which cases pass. Email addresses are masked in
 * everything sent. `matcher` is undefined when there is no API key.
 */
export async function rescoreCases(options: {
  matcher: Matcher | undefined;
  conditions: string[];
  cases: SavedCaseView[];
  cutoff: number;
  timeLimitMs?: number;
}): Promise<RescoreResult> {
  const { matcher, conditions, cases, cutoff, timeLimitMs = RESCORE_TIME_LIMIT_MS } = options;
  if (cases.length === 0) return { status: "no_cases", cutoff };
  const failed = (error: string): RescoreResult => ({ status: "failed", cutoff, error, caseCount: cases.length });
  if (!matcher) return failed("missing API key");

  const sent = conditions.map((text, index) => ({ id: `c${index}`, text: maskEmails(text), written: text }));
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeLimitMs));
    }, timeLimitMs);
  });

  async function scoreCase(savedCase: SavedCaseView): Promise<CaseResult> {
    const result = await matcher!.match(
      maskEmails(savedCase.text),
      sent.map(({ id, text }) => ({ id, text })),
      controller.signal,
    );
    // Read answers only for the IDs that were sent; every one must be a score from 0 to 1.
    const scores = sent.map(({ id, written }) => {
      const value = result.scores[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new MalformedAnswerError(`no valid score for ${id}`);
      }
      return { condition: written, score: value };
    });
    const best = Math.max(...scores.map((s) => s.score));
    const matched = best >= cutoff;
    return { case: savedCase, scores, best, matched, passed: matched === (savedCase.expected === "should_match") };
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
    return { status: "scored", cutoff, cases: results, passed, failed: results.length - passed };
  } catch (error) {
    // The other requests have no use once one has failed.
    controller.abort();
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
