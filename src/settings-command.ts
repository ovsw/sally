import { databasePath, type Env } from "./paths.ts";
import { createRulesService } from "./rules.ts";
import { openStore } from "./store.ts";
import type { CommandResult } from "./wrong-match.ts";

const USAGE = "Usage: sally settings stop-on-failure [on|off]\n";

const describe = (on: boolean) =>
  on
    ? "Stop on failure is on: when a check fails, Sally stops the turn.\n"
    : "Stop on failure is off: when a check fails, the turn goes through without your rules.\n";

/**
 * `sally settings stop-on-failure [on|off]`: shows or changes whether a failed
 * check stops the turn. It is the way to switch stopping off from a terminal,
 * for when the web app is out of reach.
 */
export function runSettingsCommand(args: string[], env: Env): CommandResult {
  const [name, value, ...rest] = args;
  if (name !== "stop-on-failure" || rest.length > 0 || (value !== undefined && value !== "on" && value !== "off")) {
    return { code: 1, stdout: "", stderr: USAGE };
  }
  const store = openStore(databasePath(env));
  try {
    const rules = createRulesService(store);
    const settings = value === undefined ? rules.settings() : rules.updateSettings({ stopOnFailure: value === "on" });
    return { code: 0, stdout: describe(settings.stopOnFailure), stderr: "" };
  } finally {
    store.close();
  }
}
