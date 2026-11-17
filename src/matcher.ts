/** One condition sent to the matcher, under an ID the matcher answers by. */
export interface MatcherCondition {
  id: string;
  text: string;
}

export interface MatchResult {
  /** A score from 0 to 1 per condition ID. */
  scores: Record<string, number>;
  /** The input token count the matcher reported, if any. */
  inputTokens: number | null;
}

/**
 * Scores how likely each condition is to hold of the text. The only real
 * implementation calls Jev; tests substitute a stand-in here.
 */
export interface Matcher {
  match(text: string, conditions: MatcherCondition[], signal: AbortSignal): Promise<MatchResult>;
}

/** The matcher's answer could not be read. */
export class MalformedAnswerError extends Error {
  constructor(detail: string) {
    super(`malformed answer: ${detail}`);
  }
}
