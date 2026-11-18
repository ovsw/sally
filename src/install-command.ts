import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { install, uninstall } from "./install.ts";
import { createJevMatcher } from "./jev.ts";
import type { Matcher } from "./matcher.ts";
import { apiKeyPath, configDir, databasePath, type Env, findApiKey } from "./paths.ts";
import { openStore } from "./store.ts";
import { type Prompt, terminalPrompt } from "./terminal-prompt.ts";

/** The oldest Node major version Sally runs on, as package.json's engines says. */
export const MIN_NODE_MAJOR = 24;

/** How long the key test waits for Jev. */
const KEY_TEST_TIMEOUT_MS = 20_000;

export interface InstallCommandOptions {
  env: Env;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether input comes from a terminal; when it does not, install asks nothing. */
  isTerminal?: boolean;
  /** Opens the prompt for the guided install; defaults to the terminal. */
  openPrompt?: () => Prompt;
  /** The matcher used to test a key; defaults to Jev. */
  matcherFor?: (apiKey: string) => Matcher;
  /** The running Node version; defaults to this process's. */
  nodeVersion?: string;
  /** The program the hooks run; defaults to this checkout's command line. */
  cliPath?: string;
  /** Returns what `claude --version` prints; defaults to running it. */
  claudeVersion?: () => string | undefined;
}

const isWindows = process.platform === "win32";

/** A message when this Node is too old for Sally; undefined when it is new enough. */
function nodeProblem(version: string): string | undefined {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (major >= MIN_NODE_MAJOR) return undefined;
  return `Sally needs Node ${MIN_NODE_MAJOR} or later, and this is Node ${version.replace(/^v/, "")}. Install a newer Node, then run "sally install" again. Nothing was changed.`;
}

/** Why a key test failed, in words that tell a wrong key from a network problem. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const status = /HTTP (\d+)/.exec(error.message)?.[1];
    if (status === "401" || status === "403") {
      return `Jev refused the key (HTTP ${status}). Check that you copied the whole key.`;
    }
    if (status) return `Jev answered with HTTP ${status}. The key may be fine; try again later.`;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `Jev did not answer within ${KEY_TEST_TIMEOUT_MS / 1000} seconds. Check your network connection.`;
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (error.message === "fetch failed") {
      const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
      return `Could not reach Jev${code}. Check your network connection.`;
    }
    return error.message;
  }
  return String(error);
}

/** Tests a key with one call through the matcher; returns why it failed, or undefined when it works. */
async function testKey(matcher: Matcher): Promise<string | undefined> {
  try {
    await matcher.match(
      "Sally is checking that this API key works.",
      [{ id: "key-test", text: "The text is a check that an API key works." }],
      AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
    );
    return undefined;
  } catch (error) {
    return describeFailure(error);
  }
}

const isPrivate = (path: string, mode: number) => isWindows || (statSync(path).mode & 0o777) === mode;

/**
 * Makes the config folder enterable and the key file readable only by the
 * user. On Windows the user folder's own permissions do this.
 */
function makePrivate(env: Env): boolean {
  if (isWindows) return false;
  const dir = configDir(env);
  const file = apiKeyPath(env);
  let changed = false;
  if (!isPrivate(dir, 0o700)) {
    chmodSync(dir, 0o700);
    changed = true;
  }
  if (existsSync(file) && !isPrivate(file, 0o600)) {
    chmodSync(file, 0o600);
    changed = true;
  }
  return changed;
}

function saveKey(env: Env, key: string): void {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  makePrivate(env);
  writeFileSync(apiKeyPath(env), key + "\n", { mode: 0o600 });
}

async function askKey(prompt: Prompt): Promise<string> {
  for (;;) {
    const key = (await prompt.askHidden("Paste your Jev API key (typing is hidden): ")).trim();
    if (key) return key;
  }
}

async function guidedInstall(options: InstallCommandOptions, prompt: Prompt): Promise<number> {
  const { env, stdout, stderr } = options;
  const say = (line: string) => stdout(line + "\n");
  const matcherFor = options.matcherFor ?? ((apiKey: string) => createJevMatcher({ apiKey }));
  const keyPath = apiKeyPath(env);

  // The key: found, or asked for; then tested once, and saved if it was typed.
  const found = findApiKey(env);
  let key: string;
  let typed = false;
  if (found) {
    key = found.key;
    say(found.source === "env" ? "Using the API key from TYPESAFE_API_KEY." : `Using the API key from ${keyPath}.`);
  } else {
    say("Sally needs a Jev API key to match your rules.");
    key = await askKey(prompt);
    typed = true;
  }
  for (;;) {
    say("Testing the key with one call to Jev...");
    const failure = await testKey(matcherFor(key));
    if (failure === undefined) {
      say("The key works.");
      break;
    }
    say(`The key test failed: ${failure}`);
    const choice = (await prompt.ask("Paste the key again, or save it anyway? [p]aste / [s]ave: ")).trim().toLowerCase();
    if (choice.startsWith("s")) break;
    if (choice.startsWith("p")) {
      key = await askKey(prompt);
      typed = true;
    }
  }
  if (typed) {
    saveKey(env, key);
    say(`Saved the key to ${keyPath}, readable only by you.`);
    if (found?.source === "env") {
      say("TYPESAFE_API_KEY is set and is used before the key file; change or unset it to use the saved key.");
    }
  } else if (found?.source === "file" && makePrivate(env)) {
    say(`Made ${keyPath} readable only by you.`);
  }

  const dbPath = databasePath(env);
  const existed = existsSync(dbPath);
  openStore(dbPath).close();
  say(existed ? `The database is at ${dbPath}.` : `Created the database at ${dbPath}.`);

  const { changes, warnings } = install({ env, cliPath: options.cliPath, claudeVersion: options.claudeVersion });
  for (const change of changes) say(change);
  if (changes.length === 0) say("The hooks and the authority line were already in place.");
  for (const warning of warnings) stderr(warning + "\n");

  say("");
  say("Sally is installed.");
  say("Next step: import your rules. In Claude Code, ask Claude to import your rules file into Sally.");
  say('To open the web app, run "sally app" and open the address it prints.');
  return 0;
}

/**
 * `sally install [--yes]`. In a terminal it is guided: it checks Node, finds
 * or asks for the API key, tests it, saves it, creates the database and
 * registers the hooks. With input that is not a terminal, or with `--yes`, it
 * asks nothing and only registers the hooks and the authority line.
 */
export async function runInstall(args: string[], options: InstallCommandOptions): Promise<number> {
  const { stdout, stderr } = options;
  const unknown = args.filter((arg) => arg !== "--yes");
  if (unknown.length > 0) {
    stderr(`Unknown option ${unknown[0]}. Usage: sally install [--yes]\n`);
    return 1;
  }
  const problem = nodeProblem(options.nodeVersion ?? process.versions.node);
  if (problem) {
    stderr(problem + "\n");
    return 1;
  }
  try {
    if (options.isTerminal && !args.includes("--yes")) {
      const prompt = (options.openPrompt ?? terminalPrompt)();
      try {
        return await guidedInstall(options, prompt);
      } finally {
        prompt.close();
      }
    }
    const { changes, warnings } = install({
      env: options.env,
      cliPath: options.cliPath,
      claudeVersion: options.claudeVersion,
    });
    for (const warning of warnings) stderr(warning + "\n");
    stdout((changes.length > 0 ? changes.join("\n") : "Sally is already installed.") + "\n");
    return 0;
  } catch (error) {
    stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}

/**
 * `sally uninstall`: removes the hooks and the authority line, and leaves the
 * API key and the database, saying where they are.
 */
export function runUninstall(args: string[], options: Pick<InstallCommandOptions, "env" | "stdout" | "stderr">): number {
  const { env, stdout, stderr } = options;
  if (args.length > 0) {
    stderr(`Unknown option ${args[0]}. Usage: sally uninstall\n`);
    return 1;
  }
  try {
    const { changes } = uninstall({ env });
    const lines = changes.length > 0 ? changes : ["Sally is not installed."];
    if (existsSync(apiKeyPath(env))) lines.push(`Your API key is still at ${apiKeyPath(env)}.`);
    if (existsSync(databasePath(env))) lines.push(`Your database, with your rules, is still at ${databasePath(env)}.`);
    stdout(lines.join("\n") + "\n");
    return 0;
  } catch (error) {
    stderr((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}
