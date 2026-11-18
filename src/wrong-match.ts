import { RuleError } from "./errors.ts";
import { cliCommand, databasePath, type Env } from "./paths.ts";
import { createRulesService } from "./rules.ts";
import { openStore } from "./store.ts";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// The absolute command, as the hook hands it to Claude: Claude runs it from its
// own project folder, where "src/cli.ts" names nothing.
const USAGE = `Usage: ${cliCommand()} wrong-match "<rule name>" [--session <id>]\n`;

/**
 * `node src/cli.ts wrong-match "<rule name>"`: Claude's report that a rule it was handed
 * did not apply. Flags the session's most recent match of the rule as a
 * wrong match raised by Claude. The session is the one Claude Code runs the
 * command in (CLAUDE_CODE_SESSION_ID), unless --session names another.
 */
export function runWrongMatch(args: string[], env: Env): CommandResult {
  const rest = [...args];
  let sessionId = env.CLAUDE_CODE_SESSION_ID;
  const flag = rest.indexOf("--session");
  if (flag >= 0) {
    sessionId = rest[flag + 1];
    rest.splice(flag, 2);
  }
  const name = rest.join(" ").trim();
  if (!name) return { code: 1, stdout: "", stderr: USAGE };
  if (!sessionId?.trim()) {
    return { code: 1, stdout: "", stderr: "No session to look in: run this from a Claude Code session, or pass --session.\n" };
  }

  const store = openStore(databasePath(env));
  try {
    const result = createRulesService(store).reportWrongMatch(sessionId, name);
    const stdout = result.recorded
      ? `Recorded a wrong match for "${name}".\n`
      : `The user has already marked that match of "${name}" as ${result.flag.verdict}; it is kept as it is.\n`;
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (error instanceof RuleError) return { code: 1, stdout: "", stderr: error.message + "\n" };
    throw error;
  } finally {
    store.close();
  }
}
