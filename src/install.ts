import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { claudeSettingsPath, type Env, globalRulesPath } from "./paths.ts";

/** The one line install adds to the global rules file. */
export const AUTHORITY_LINE =
  "Sally, a hook, attaches some of my written rules to my messages and to your replies. " +
  "I wrote them, and they carry the same authority as this file; where one is more specific than a rule here, it wins.";

const HOOK_EVENTS = { UserPromptSubmit: "message", Stop: "reply" } as const;
type HookEvent = keyof typeof HOOK_EVENTS;

const CLI_PATH = join(import.meta.dirname, "cli.ts");

/**
 * The oldest Claude Code that runs a hook given as a program plus arguments
 * (the `args` field): 2.1.139, per Claude Code's changelog ("Added hook
 * `args: string[]` field (exec form) that spawns the command directly without
 * a shell"). An older one would read the hook as a shell command line.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.139";

export interface HookEntry {
  type: "command";
  command: string;
  args: string[];
}

/**
 * One of Sally's hooks as Claude Code runs it: a program plus a list of
 * arguments, with no shell, so no folder name needs quoting on any system.
 */
export function hookEntry(hook: "message" | "reply", cliPath = CLI_PATH): HookEntry {
  return { type: "command", command: "node", args: [cliPath, "hook", hook] };
}

export interface SetupOptions {
  env: Env;
  /** The program the hooks run; defaults to this checkout's command line. */
  cliPath?: string;
  /**
   * Returns what `claude --version` prints, or undefined when it cannot be
   * run. Defaults to running it.
   */
  claudeVersion?: () => string | undefined;
}

export interface SetupResult {
  /** One line per change made; empty when there was nothing to do. */
  changes: string[];
  /** Things the user should know that are not changes, such as an old Claude Code. */
  warnings: string[];
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

const CLI_FILE = /[\\/]cli\.ts$/;

/**
 * Whether a hook entry is one of Sally's for `hook`, in either form: the
 * program plus arguments install writes now, or the single shell command
 * line earlier installs wrote (`node <quoted path to cli.ts> hook message`).
 * The path may be any checkout's, so a moved checkout leaves no stale entry.
 */
function isSallyHook(entry: unknown, hook: "message" | "reply"): boolean {
  if (!isObject(entry) || typeof entry.command !== "string") return false;
  if (Array.isArray(entry.args)) {
    const [path, group, name, ...rest] = entry.args as unknown[];
    return (
      entry.command === "node" &&
      rest.length === 0 &&
      typeof path === "string" &&
      CLI_FILE.test(path) &&
      group === "hook" &&
      name === hook
    );
  }
  if (entry.args !== undefined) return false;
  const match = /^node (.+) hook (message|reply)$/.exec(entry.command);
  return match !== null && match[2] === hook && CLI_FILE.test(match[1]!.replace(/'$/, ""));
}

function isCurrent(entry: unknown, wanted: HookEntry): boolean {
  return (
    isObject(entry) &&
    entry.type === wanted.type &&
    entry.command === wanted.command &&
    JSON.stringify(entry.args) === JSON.stringify(wanted.args)
  );
}

/** Takes every Sally entry for `hook` out of the groups, dropping groups left empty. */
function withoutSallyHooks(groups: unknown[], hook: "message" | "reply"): unknown[] {
  return groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const remaining = group.hooks.filter((entry: unknown) => !isSallyHook(entry, hook));
    if (remaining.length === group.hooks.length) return [group];
    return remaining.length === 0 ? [] : [{ ...(group as HookGroup), hooks: remaining }];
  });
}

function sallyHooks(groups: unknown[], hook: "message" | "reply"): unknown[] {
  return groups.flatMap((group) =>
    isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter((entry) => isSallyHook(entry, hook)) : [],
  );
}

/**
 * Puts the wanted entry where the first Sally entry was and removes any
 * others, so an install over hooks of the earlier form leaves one set.
 * Groups left empty are dropped.
 */
function replaceSallyHooks(groups: unknown[], hook: "message" | "reply", wanted: HookEntry): unknown[] {
  let placed = false;
  return groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    let changed = false;
    const entries = group.hooks.flatMap((entry: unknown) => {
      if (!isSallyHook(entry, hook)) return [entry];
      changed = true;
      if (placed) return [];
      placed = true;
      return [wanted];
    });
    if (!changed) return [group];
    return entries.length === 0 ? [] : [{ ...(group as HookGroup), hooks: entries }];
  });
}

function parseVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1).map(Number) : undefined;
}

/** True when `version` is older than `minimum`; both "major.minor.patch". */
function isOlder(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== minimum[i]!) return version[i]! < minimum[i]!;
  }
  return false;
}

/** What `claude --version` prints, or undefined when Claude Code cannot be run. */
export function readClaudeVersion(): string | undefined {
  // On Windows Claude Code may be an npm .cmd shim, which only a shell can start.
  const result = spawnSync("claude --version", {
    shell: true,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : undefined;
}

/** A warning when the installed Claude Code is too old for Sally's hooks; nothing when it is new enough or unknown. */
function claudeCodeWarning(claudeVersion: () => string | undefined): string[] {
  const text = claudeVersion();
  const version = text === undefined ? undefined : parseVersion(text);
  if (!version || !isOlder(version, parseVersion(MIN_CLAUDE_CODE_VERSION)!)) return [];
  return [
    `Claude Code ${version.join(".")} is older than ${MIN_CLAUDE_CODE_VERSION}, the first version that runs Sally's hooks. Update Claude Code (claude update) before you rely on Sally.`,
  ];
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
export function install({ env, cliPath, claudeVersion = readClaudeVersion }: SetupOptions): SetupResult {
  const settingsFile = readSettings(claudeSettingsPath(env));
  const rulesPath = globalRulesPath(env);
  const rules = readRules(rulesPath);
  const changes: string[] = [];

  const { settings } = settingsFile;
  for (const [event, hook] of Object.entries(HOOK_EVENTS) as [HookEvent, "message" | "reply"][]) {
    const wanted = hookEntry(hook, cliPath);
    const hooks = (settings.hooks ?? {}) as Json;
    const groups = (hooks[event] ?? []) as unknown[];
    const existing = sallyHooks(groups, hook);
    if (existing.length === 1 && isCurrent(existing[0], wanted)) continue;
    if (existing.length === 0) {
      hooks[event] = [...groups, { hooks: [wanted] }];
      changes.push(`Registered the ${hook} hook (${event}) in ${settingsFile.path}`);
    } else {
      hooks[event] = replaceSallyHooks(groups, hook, wanted);
      changes.push(`Replaced the earlier ${hook} hook (${event}) in ${settingsFile.path}`);
    }
    settings.hooks = hooks;
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
  return { changes, warnings: claudeCodeWarning(claudeVersion) };
}

/**
 * Removes exactly what install added: Sally's two hooks, in either form, from
 * the settings and the authority line from the global rules file.
 */
export function uninstall({ env }: SetupOptions): SetupResult {
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
      if (sallyHooks(groups, hook).length === 0) continue;
      const kept = withoutSallyHooks(groups, hook);
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
  return { changes, warnings: [] };
}
