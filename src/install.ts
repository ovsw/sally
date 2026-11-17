import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeSettingsPath, type Env, globalRulesPath } from "./paths.ts";

/** The one line install adds to the global rules file. */
export const AUTHORITY_LINE =
  "Sally, a hook, attaches some of my written rules to my messages and to your replies. " +
  "I wrote them, and they carry the same authority as this file; where one is more specific than a rule here, it wins.";

const HOOK_EVENTS = { UserPromptSubmit: "message", Stop: "reply" } as const;
type HookEvent = keyof typeof HOOK_EVENTS;

const CLI_PATH = join(import.meta.dirname, "cli.ts");

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command Claude Code runs for one of Sally's hooks. */
export function hookCommand(hook: "message" | "reply", cliPath = CLI_PATH): string {
  return `node ${shellQuote(cliPath)} hook ${hook}`;
}

export interface SetupOptions {
  env: Env;
  /** The program the hooks run; defaults to this checkout's command line. */
  cliPath?: string;
}

export interface SetupResult {
  /** One line per change made; empty when there was nothing to do. */
  changes: string[];
}

export class SetupError extends Error {}

type Json = Record<string, unknown>;
interface HookGroup extends Json {
  hooks?: unknown;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface SettingsFile {
  path: string;
  settings: Json;
  indent: string;
}

function readSettings(path: string): SettingsFile {
  if (!existsSync(path)) return { path, settings: {}, indent: "  " };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { path, settings: {}, indent: "  " };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new SetupError(`${path} is not valid JSON; fix it first. Nothing was changed.`);
  }
  if (!isObject(settings)) throw new SetupError(`${path} does not hold a JSON object. Nothing was changed.`);
  if (settings.hooks !== undefined) {
    if (!isObject(settings.hooks)) throw new SetupError(`"hooks" in ${path} is not an object. Nothing was changed.`);
    for (const event of Object.keys(HOOK_EVENTS)) {
      const groups = settings.hooks[event];
      if (groups !== undefined && !Array.isArray(groups)) {
        throw new SetupError(`"hooks.${event}" in ${path} is not a list. Nothing was changed.`);
      }
    }
  }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ";
  return { path, settings, indent };
}

function hasCommand(groups: unknown[], command: string): boolean {
  return groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => isObject(hook) && hook.command === command),
  );
}

/** Writes through a temporary file and a rename, so the file is never left half-written. */
function writeAtomically(path: string, content: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.sally-${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, target);
}

function writeSettings({ path, settings, indent }: SettingsFile): void {
  writeAtomically(path, JSON.stringify(settings, null, indent) + "\n");
}

/**
 * Writes the rules file after the settings may already have changed. If this
 * write fails, the error says which changes were already made, so the user
 * knows the two files are out of step and that a rerun finishes the job.
 */
function writeRules(path: string, content: string, changes: string[], rerun: string): void {
  try {
    writeAtomically(path, content);
  } catch (error) {
    if (changes.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new SetupError(
      `Could not write ${path}: ${reason}\nAlready done:\n${changes.join("\n")}\nFix the problem and run "sally ${rerun}" again to finish.`,
    );
  }
}

function readRules(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const hasLine = (text: string, line: string) => text.split(/\r?\n/).some((l) => l.trim() === line);

/**
 * Registers the message hook and the reply hook in the user's Claude Code
 * settings and adds the authority line to the global rules file. Running it
 * again changes nothing. Everything else in both files is left as it was.
 */
export function install({ env, cliPath }: SetupOptions): SetupResult {
  const settingsFile = readSettings(claudeSettingsPath(env));
  const rulesPath = globalRulesPath(env);
  const rules = readRules(rulesPath);
  const changes: string[] = [];

  const { settings } = settingsFile;
  for (const [event, hook] of Object.entries(HOOK_EVENTS) as [HookEvent, "message" | "reply"][]) {
    const command = hookCommand(hook, cliPath);
    const hooks = (settings.hooks ?? {}) as Json;
    const groups = (hooks[event] ?? []) as unknown[];
    if (hasCommand(groups, command)) continue;
    hooks[event] = [...groups, { hooks: [{ type: "command", command }] }];
    settings.hooks = hooks;
    changes.push(`Registered the ${hook} hook (${event}) in ${settingsFile.path}`);
  }
  if (changes.length > 0) writeSettings(settingsFile);

  if (!hasLine(rules, AUTHORITY_LINE)) {
    // A blank line before the authority line, which uninstall takes out again.
    let text = rules;
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    if (text !== "") text += "\n";
    writeRules(rulesPath, text + AUTHORITY_LINE + "\n", changes, "install");
    changes.push(`Added Sally's authority line to ${rulesPath}`);
  }
  return { changes };
}

/**
 * Removes exactly what install added: Sally's two hooks from the settings and
 * the authority line from the global rules file.
 */
export function uninstall({ env, cliPath }: SetupOptions): SetupResult {
  const settingsFile = readSettings(claudeSettingsPath(env));
  const rulesPath = globalRulesPath(env);
  const rules = readRules(rulesPath);
  const changes: string[] = [];

  const { settings } = settingsFile;
  if (isObject(settings.hooks)) {
    const hooks = settings.hooks;
    for (const [event, hook] of Object.entries(HOOK_EVENTS) as [HookEvent, "message" | "reply"][]) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const command = hookCommand(hook, cliPath);
      if (!hasCommand(groups, command)) continue;
      const kept = groups.flatMap((group: unknown) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
        const remaining = group.hooks.filter((h: unknown) => !(isObject(h) && h.command === command));
        if (remaining.length === group.hooks.length) return [group];
        return remaining.length === 0 ? [] : [{ ...(group as HookGroup), hooks: remaining }];
      });
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      changes.push(`Removed the ${hook} hook (${event}) from ${settingsFile.path}`);
    }
    if (Object.keys(hooks).length === 0 && changes.length > 0) delete settings.hooks;
  }
  if (changes.length > 0) writeSettings(settingsFile);

  if (hasLine(rules, AUTHORITY_LINE)) {
    const lines = rules.split("\n");
    const at = lines.findIndex((l) => l.replace(/\r$/, "").trim() === AUTHORITY_LINE);
    lines.splice(at, 1);
    // Take out the blank line install put before it.
    if (at > 0 && lines[at - 1]?.trim() === "") lines.splice(at - 1, 1);
    writeRules(rulesPath, lines.join("\n"), changes, "uninstall");
    changes.push(`Removed Sally's authority line from ${rulesPath}`);
  }
  return { changes };
}
