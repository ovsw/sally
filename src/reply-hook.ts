import { type CheckInput, type CheckResult, createEngine } from "./engine.ts";
import { createJevMatcher } from "./jev.ts";
import type { Matcher } from "./matcher.ts";
import { formatAttached, formatBroken } from "./message-hook.ts";
import { databasePath, type Env, readApiKey } from "./paths.ts";
import { createRulesService } from "./rules.ts";
import { openStore } from "./store.ts";
import { finalReplyFromTranscript } from "./transcript.ts";
import { recordReply, recordRevisedReply } from "./turns.ts";

export interface ReplyHookOptions {
  env: Env;
  /** Replaces the Jev matcher built from the API key; tests pass a stand-in. */
  matcher?: Matcher;
}

interface StopInput {
  session_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
}

/** Claude's final reply: from the hook input when present, otherwise from the session transcript. */
function finalReply(input: StopInput): string | undefined {
  if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()) {
    return input.last_assistant_message;
  }
  if (typeof input.transcript_path === "string" && input.transcript_path) {
    try {
      return finalReplyFromTranscript(input.transcript_path);
    } catch {
      // A transcript that cannot be read holds no reply to check.
      return undefined;
    }
  }
  return undefined;
}

/** What the user sees when a reply check failed: the reply is already written, so it stands, with this warning. */
export function formatUnchecked(failure: string): string {
  return `Sally could not check this reply against your rules: ${failure}. The reply was not checked.`;
}

/**
 * The stop hook. Takes the hook input Claude Code sends on stdin and returns
 * what to print on stdout: a block with the matched instructions as the
 * reason when a reply-check rule matches, otherwise nothing. When Claude Code
 * is already continuing because of a stop hook, the revised reply is
 * recorded and let through without a check. When the check failed and the
 * stop-on-failure setting is on, the user gets a warning that the reply was
 * not checked; Claude is not made to continue. It never throws: if Sally
 * itself is broken, the reply stands, with a warning to the user.
 */
export async function runReplyHook(stdin: string, options: ReplyHookOptions): Promise<string> {
  try {
    const input = JSON.parse(stdin) as StopInput;
    const reply = finalReply(input);
    if (!reply) return "";

    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    const checkInput: CheckInput = {
      checkType: "reply",
      text: reply,
      sessionId,
      cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    };
    const continuing = input.stop_hook_active === true;

    const store = openStore(databasePath(options.env));
    try {
      const apiKey = options.matcher || continuing ? undefined : readApiKey(options.env);
      const rules = createRulesService(store);
      const engine = createEngine({
        store,
        rules,
        matcher: options.matcher ?? (apiKey ? createJevMatcher({ apiKey }) : undefined),
      });

      // The once-per-turn guard: a reply already sent back is never sent back again.
      if (continuing) {
        recordRevisedReply(store, { sessionId, reply });
        engine.skip(checkInput);
        return "";
      }

      let result: CheckResult | undefined;
      try {
        result = await engine.check(checkInput);
      } finally {
        recordReply(store, { sessionId, reply, replyCheckId: result?.checkId });
      }
      if (result.outcome === "failed" && rules.settings().stopOnFailure) {
        // A warning for the user only: with no decision, Claude stops as it meant to.
        return JSON.stringify({ systemMessage: formatUnchecked(result.failure ?? "unknown error") });
      }
      if (result.outcome !== "sent_back") return "";
      return JSON.stringify({ decision: "block", reason: formatAttached(result.matches) });
    } finally {
      store.close();
    }
  } catch (error) {
    return JSON.stringify({ systemMessage: formatBroken("reply", error) });
  }
}
