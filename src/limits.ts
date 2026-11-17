import type { MatcherCondition } from "./matcher.ts";

// Jev's request limits, per its models page. Long-context mode, which would
// raise them, is never used.

/** Tokens one request may hold: the state plus all its questions. */
export const REQUEST_TOKEN_LIMIT = 64_000;
/** Tokens the state plus any one question may hold. */
export const QUESTION_TOKEN_LIMIT = 32_000;
/** The share of the request limit from which the app warns. */
export const REQUEST_WARNING_SHARE = 0.8;

/** What one question adds to a request besides its text: its ID, type and wrapping. */
const QUESTION_OVERHEAD_TOKENS = 16;
/** What a request adds besides the state and the questions: the model name and wrapping. */
const REQUEST_OVERHEAD_TOKENS = 32;
/** The least room the text is given, however long a condition is. */
const MIN_TEXT_TOKENS = 1_000;

const encoder = new TextEncoder();

/**
 * A cautious count of the tokens a text takes: one per three bytes of UTF-8.
 * English runs nearer four characters a token, and a character outside ASCII
 * takes two to four bytes, so this errs high and a request sized by it fits.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 3);
}

const questionTokens = (condition: MatcherCondition) => estimateTokens(condition.text) + QUESTION_OVERHEAD_TOKENS;

/** Whether one condition fits a request beside the least room the text is given. */
export function conditionFits(text: string): boolean {
  return estimateTokens(text) + QUESTION_OVERHEAD_TOKENS + MIN_TEXT_TOKENS + REQUEST_OVERHEAD_TOKENS <= QUESTION_TOKEN_LIMIT;
}

/** The most tokens the text may take so that it fits beside its longest question. */
export function textTokenBudget(conditions: MatcherCondition[]): number {
  const longest = Math.max(0, ...conditions.map(questionTokens));
  return Math.max(MIN_TEXT_TOKENS, QUESTION_TOKEN_LIMIT - REQUEST_OVERHEAD_TOKENS - longest);
}

/**
 * The text cut to its last part when it takes more than `maxTokens`, so the
 * end of a long message or reply, where the request usually is, is kept.
 */
export function cutToLastPart(text: string, maxTokens: number): { text: string; cut: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, cut: false };
  const maxBytes = maxTokens * 3;
  // Walk back from the end by whole characters until the byte budget is spent.
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const size = utf8Size(chars[start - 1]!.codePointAt(0)!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start--;
  }
  return { text: chars.slice(start).join(""), cut: true };
}

/** The bytes one code point takes in UTF-8. A lone surrogate is written as U+FFFD, three bytes. */
const utf8Size = (codePoint: number) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/**
 * The conditions split into requests that each fit Jev's request limit beside
 * the text, in their given order. One request when they all fit.
 */
export function splitIntoRequests(text: string, conditions: MatcherCondition[]): MatcherCondition[][] {
  const room = REQUEST_TOKEN_LIMIT - REQUEST_OVERHEAD_TOKENS - estimateTokens(text);
  const requests: MatcherCondition[][] = [];
  let current: MatcherCondition[] = [];
  let used = 0;
  for (const condition of conditions) {
    const size = questionTokens(condition);
    if (current.length > 0 && used + size > room) {
      requests.push(current);
      current = [];
      used = 0;
    }
    current.push(condition);
    used += size;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}
