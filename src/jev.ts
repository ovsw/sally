import { MalformedAnswerError, type Matcher } from "./matcher.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export interface JevOptions {
  apiKey: string;
  url?: string;
  model?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The matcher that calls TypeSafe's Jev: the text is the state and each
 * condition is one Noul question, so Jev sees nothing but those. Long-context
 * mode is never asked for: the engine keeps each request inside Jev's normal
 * limits instead (see limits.ts).
 */
export function createJevMatcher({ apiKey, url = JEV_URL, model = JEV_MODEL }: JevOptions): Matcher {
  return {
    async match(text, conditions, signal) {
      const questions = Object.fromEntries(
        conditions.map((c) => [c.id, { type: "noul", instructions: c.text }]),
      );
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state: text, questions }),
        signal,
      });
      if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new MalformedAnswerError("response is not JSON");
      }
      if (!isObject(body) || !isObject(body.answers)) {
        throw new MalformedAnswerError("response has no answers");
      }

      // Only IDs that were sent are read; anything else in the answer is ignored.
      const scores: Record<string, number> = {};
      for (const { id } of conditions) {
        const answer = body.answers[id];
        if (!isObject(answer) || typeof answer.noul !== "number") {
          throw new MalformedAnswerError(`no Noul score for ${id}`);
        }
        scores[id] = answer.noul;
      }
      const tokens = isObject(body.usage) ? body.usage.input_tokens : undefined;
      return { scores, inputTokens: typeof tokens === "number" ? tokens : null };
    },
  };
}
