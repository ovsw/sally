import { createEngine, type Firing } from "./engine.ts";
import { createJevMatcher } from "./jev.ts";
import type { Matcher } from "./matcher.ts";
import { databasePath, type Env, readApiKey } from "./paths.ts";
import { createRulesService } from "./rules.ts";
import { openStore } from "./store.ts";

export const ATTACHED_HEADER =
  "Sally: the rules below are the user's own written rules, and they apply to this message.";

/** The last line of the attached text: how Claude reports a rule that does not apply. */
export const REPORT_LINE =
  'If one of these rules does not apply to this message, say so by running: sally wrong-match "<rule name>"';

export interface MessageHookOptions {
  env: Env;
  /** Replaces the Jev matcher built from the API key; tests pass a stand-in. */
  matcher?: Matcher;
}

/**
 * The text attached to the user's message: the fixed header, then each
 * rule's name and instruction, then how to report a rule that does not apply.
 */
export function formatAttached(firings: Firing[]): string {
  const rules = firings.map((f) => `Rule: ${f.name}\n${f.instruction}`);
  return [ATTACHED_HEADER, ...rules, REPORT_LINE].join("\n\n");
}

/**
 * The user-prompt-submit hook. Takes the hook input Claude Code sends on
 * stdin and returns what to print on stdout: additional context for the
 * turn when a rule fires, otherwise nothing. It never throws.
 */
export async function runMessageHook(stdin: string, options: MessageHookOptions): Promise<string> {
  try {
    const input = JSON.parse(stdin) as { prompt?: unknown; session_id?: unknown; cwd?: unknown };
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") return "";

    const store = openStore(databasePath(options.env));
    try {
      const apiKey = options.matcher ? undefined : readApiKey(options.env);
      const engine = createEngine({
        store,
        rules: createRulesService(store),
        matcher: options.matcher ?? (apiKey ? createJevMatcher({ apiKey }) : undefined),
      });
      const result = await engine.check({
        checkType: "message",
        text: input.prompt,
        sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      });
      if (result.outcome !== "attached") return "";
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: formatAttached(result.firings),
        },
      });
    } finally {
      store.close();
    }
  } catch {
    return "";
  }
}
