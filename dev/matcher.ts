import type { Matcher } from "../src/matcher.ts";

// [condition pattern, text pattern, score]: a condition scores high when the
// text holds its keyword.
const KEYWORDS: Array<[RegExp, RegExp, number]> = [
  [/commit/i, /commit/i, 0.86],
  [/short answer|brief/i, /\?|quick|how/i, 0.72],
  [/migration/i, /migration|schema|table/i, 0.81],
  [/release notes/i, /changelog-never-matches/i, 0.9],
  [/style guide/i, /style/i, 0.8],
  [/test/i, /test/i, 0.63],
  [/deploy/i, /deploy/i, 0.77],
  [/apolog/i, /sorry|apolog/i, 0.88],
];

/**
 * The stand-in for Jev that `pnpm dev` runs on, so the sample app works with
 * no API key. Scores are made up from keywords; `bigTokens` marks the texts
 * reported as a large request.
 */
export function devMatcher(options: { bigTokens?: (text: string) => boolean } = {}): Matcher {
  return {
    async match(text, conditions) {
      const scores: Record<string, number> = {};
      for (const condition of conditions) {
        let score = 0.12;
        for (const [inCondition, inText, value] of KEYWORDS) {
          if (inCondition.test(condition.text) && inText.test(text)) score = Math.max(score, value);
        }
        scores[condition.id] = score;
      }
      return { scores, inputTokens: options.bigTokens?.(text) ? 55_000 : 300 + text.length };
    },
  };
}
