import { createEngine, type Match } from "./engine.ts";
import { createJevMatcher } from "./jev.ts";
import type { Matcher } from "./matcher.ts";
import { cliCommand, databasePath, type Env, readApiKey } from "./paths.ts";
import { createRulesService } from "./rules.ts";
import { openStore } from "./store.ts";

// Sally's text says plainly that it is an automatic reminder, not a message:
// Claude otherwise answers it as if someone had written to it, and the
// conversation drifts from the user's request to Sally.
export const ATTACHED_HEADER =
  "Sally, an automatic reminder, not a message to answer: the rules below are the user's own written rules, and they apply to this message. Follow them in your work for the user without mentioning Sally or these rules.";

/**
 * The last line of the text Sally hands Claude: how Claude reports a rule that
 * does not fit, quietly. Claude works in some other project's folder, so the
 * command names this checkout's command line by its absolute path.
 */
export const REPORT_LINE = `If one of these rules does not fit, run this and leave it out of your reply: ${cliCommand()} wrong-match "<rule name>"`;

export interface MessageHookOptions {
  env: Env;
  /** Replaces the Jev matcher built from the API key; tests pass a stand-in. */
  matcher?: Matcher;
}

/**
 * The text attached to the user's message: the fixed header, then each
 * rule's name and instruction, then how to report a rule that does not apply.
 */
export function formatAttached(matches: Match[]): string {
  const rules = matches.map((f) => `Rule: ${f.name}\n${f.instruction}`);
  return [ATTACHED_HEADER, ...rules, REPORT_LINE].join("\n\n");
}

/**
 * How the user switches stopping off; named in the text of a blocked message.
 * The user is in some other project's folder, so the command names this
 * checkout's command line by its absolute path.
 */
export const SWITCH_OFF_LINE = `To let messages through when a check fails, switch off "Stop the turn when a check fails" on the Settings screen of Sally's web app, or run: ${cliCommand()} settings stop-on-failure off`;

/** What the user sees when a failed message check blocks the message. */
export function formatBlocked(failure: string): string {
  return [
    `Sally could not check this message against your rules: ${failure}. It was not sent to Claude.`,
    "Send it again to retry.",
    SWITCH_OFF_LINE,
  ].join("\n");
}

/** A short, one-line account of something thrown. */
export function inAFewWords(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
  return text.length > 120 ? `${text.slice(0, 120)}...` : text || "unknown error";
}

/** What the user sees when Sally itself is broken: the turn goes through, with this warning. */
export function formatBroken(what: "message" | "reply", error: unknown): string {
  return `Sally is not working, so this ${what} was not checked against your rules: ${inAFewWords(error)}`;
}

/**
 * The user-prompt-submit hook. Takes the hook input Claude Code sends on
 * stdin and returns what to print on stdout: additional context for the
 * turn when a rule matches; a block, with the reason shown to the user, when
 * the check failed and the stop-on-failure setting is on; otherwise nothing.
 * It never throws: if Sally itself is broken (the database cannot be opened,
 * say), the message goes through with a warning to the user, so that a
 * broken Sally never blocks every message.
 */
export async function runMessageHook(stdin: string, options: MessageHookOptions): Promise<string> {
  try {
    const input = JSON.parse(stdin) as { prompt?: unknown; session_id?: unknown; cwd?: unknown };
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") return "";

    const store = openStore(databasePath(options.env));
    try {
      const apiKey = options.matcher ? undefined : readApiKey(options.env);
      const rules = createRulesService(store);
      const engine = createEngine({
        store,
        rules,
        matcher: options.matcher ?? (apiKey ? createJevMatcher({ apiKey }) : undefined),
      });
      const result = await engine.check({
        checkType: "message",
        text: input.prompt,
        sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
      });
      if (result.outcome === "failed" && rules.settings().stopOnFailure) {
        // The reason is shown to the user and never reaches Claude; Claude Code
        // shows the message's text with it, so it can be sent again.
        return JSON.stringify({ decision: "block", reason: formatBlocked(result.failure ?? "unknown error") });
      }
      if (result.outcome !== "attached") return "";
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: formatAttached(result.matches),
        },
      });
    } finally {
      store.close();
    }
  } catch (error) {
    return JSON.stringify({ systemMessage: formatBroken("message", error) });
  }
}
