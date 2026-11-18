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

/** What stands in for the middle of a text that was cut. */
export const CUT_NOTE = "\n[…]\n";

/**
 * The text cut to fit `maxTokens` when it takes more: its start and its end
 * are kept and the middle goes, since what someone asks for usually comes
 * before or after a long passage, not inside it.
 */
export function cutToFit(text: string, maxTokens: number): { text: string; cut: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, cut: false };
  const room = maxTokens * 3 - encoder.encode(CUT_NOTE).length;
  // Whole characters only, from each end, half the room each.
  const chars = Array.from(text);
  let headBytes = 0;
  let head = 0;
  while (head < chars.length) {
    const size = utf8Size(chars[head]!.codePointAt(0)!);
    if (headBytes + size > room / 2) break;
    headBytes += size;
    head++;
  }
  let tailBytes = 0;
  let tail = chars.length;
  while (tail > head) {
    const size = utf8Size(chars[tail - 1]!.codePointAt(0)!);
    if (headBytes + tailBytes + size > room) break;
    tailBytes += size;
    tail--;
  }
  return { text: chars.slice(0, head).join("") + CUT_NOTE + chars.slice(tail).join(""), cut: true };
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
