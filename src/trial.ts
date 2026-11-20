import { cutToFit, splitIntoRequests, textTokenBudget } from "./limits.ts";
import { MalformedAnswerError, type Matcher } from "./matcher.ts";
import { maskEmails } from "./text.ts";

/** How long a trial may wait for Jev. */
export const TRIAL_TIME_LIMIT_MS = 20_000;

/**
 * How a trial's conditions scored against its text. "failed" when Jev could
 * not score them, with the reason in `error`. `cut` says the text was too long
 * for Jev and lost its middle, as it would in a real check.
 */
export type TrialResult =
  | {
      status: "scored";
      cutoff: number;
      /** Each condition with its score, in the order given. */
      scores: { condition: string; score: number }[];
      best: number;
      /** Whether a rule with these conditions would match: a condition reaches the cutoff. */
      matched: boolean;
      cut: boolean;
    }
  | { status: "failed"; cutoff: number; error: string };

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
  }
}

/**
 * Scores the conditions against the text as a check would send them: email
 * addresses masked, a text too long for Jev cut in the middle, and conditions
 * split across parallel requests when one would not hold them. Records
 * nothing. `matcher` is undefined when there is no API key.
 */
export async function runTrial(options: {
  matcher: Matcher | undefined;
  text: string;
  conditions: string[];
  cutoff: number;
  timeLimitMs?: number;
}): Promise<TrialResult> {
  const { matcher, text, conditions, cutoff, timeLimitMs = TRIAL_TIME_LIMIT_MS } = options;
  if (!matcher) return { status: "failed", cutoff, error: "missing API key" };

  const sent = conditions.map((written, index) => ({ id: `c${index}`, text: maskEmails(written), written }));
  const questions = sent.map(({ id, text }) => ({ id, text }));
  const budget = textTokenBudget(questions);
  const { cut } = cutToFit(text, budget);
  // Masked before it is cut, so a cut cannot split an address and leave half of it.
  const sentText = cutToFit(maskEmails(text), budget).text;

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeLimitMs));
    }, timeLimitMs);
  });
  try {
    const parts = splitIntoRequests(sentText, questions);
    const results = await Promise.race([
      Promise.all(parts.map((part) => matcher.match(sentText, part, controller.signal))),
      timeout,
    ]);
    // Each request is read only for the conditions it carried; every answer must be a score from 0 to 1.
    const answers = new Map<string, unknown>();
    parts.forEach((part, index) => {
      for (const { id } of part) answers.set(id, results[index]!.scores[id]);
    });
    const scores = sent.map(({ id, written }) => {
      const value = answers.get(id);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new MalformedAnswerError(`no valid score for ${id}`);
      }
      return { condition: written, score: value };
    });
    const best = Math.max(...scores.map((s) => s.score));
    return { status: "scored", cutoff, scores, best, matched: best >= cutoff, cut };
  } catch (error) {
    controller.abort();
    return { status: "failed", cutoff, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
