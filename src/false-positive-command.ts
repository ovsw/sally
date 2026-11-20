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
const USAGE = `Usage: ${cliCommand()} false-positive "<rule name>" [--session <id>]\n`;

/**
 * `node src/cli.ts false-positive "<rule name>"`: Claude's report that a rule it
 * was handed did not apply. Marks the session's most recent match of the rule
 * as a false positive. The session is the one Claude Code runs the command in
 * (CLAUDE_CODE_SESSION_ID), unless --session names another.
 */
export function runFalsePositive(args: string[], env: Env): CommandResult {
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
    const result = createRulesService(store).reportFalsePositive(sessionId, name);
    const stdout = result.recorded
      ? `Recorded a false positive for "${name}".\n`
      : `That match of "${name}" is already marked as a false positive.\n`;
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (error instanceof RuleError) return { code: 1, stdout: "", stderr: error.message + "\n" };
    throw error;
  } finally {
    store.close();
  }
}
