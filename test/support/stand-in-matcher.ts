import type { Matcher, MatcherCondition, MatchResult } from "../../src/matcher.ts";

export interface StandInCall {
  text: string;
  conditions: MatcherCondition[];
}

export interface StandIn extends Matcher {
  calls: StandInCall[];
}

/**
 * A stand-in for Jev. Scores each condition by its text from `scores`
 * (0 when absent). `answer` can replace the whole answer, to return extra
 * IDs, bad values or errors.
 */
export function standInMatcher(
  scores: Record<string, number> = {},
  options: {
    inputTokens?: number | null;
    answer?: (conditions: MatcherCondition[], signal: AbortSignal) => Promise<MatchResult>;
  } = {},
): StandIn {
  const calls: StandInCall[] = [];
  return {
    calls,
    async match(text, conditions, signal) {
      calls.push({ text, conditions });
      if (options.answer) return options.answer(conditions, signal);
      return {
        scores: Object.fromEntries(conditions.map((c) => [c.id, scores[c.text] ?? 0])),
        inputTokens: options.inputTokens === undefined ? 42 : options.inputTokens,
      };
    },
  };
}
