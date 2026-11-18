import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { claudeDir, claudeSettingsPath, type Env, globalRulesPath } from "./paths.ts";

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

/** The import skill's name, which is also its folder and its command: /sally-import. */
export const SKILL_NAME = "sally-import";

/** The skill file install writes: a user-level Claude Code skill. */
export function skillPath(env: Env): string {
  return join(claudeDir(env), "skills", SKILL_NAME, "SKILL.md");
}

/** Sally's mark in the skill's frontmatter. A skill without it is the user's own. */
const SKILL_MARK = /^[ \t]+installed-by:[ \t]*sally[ \t]*$/m;

/** The full instructions the skill points to, in the checkout whose command line the hooks run. */
export function skillInstructionsPath(cliPath = CLI_PATH): string {
  return resolve(dirname(cliPath), "..", "skill", "import.md");
}

/**
 * The installed skill: short, marked as Sally's, and pointing to the full
 * instructions in the checkout, so updating the checkout updates the skill.
 */
export function skillContent(cliPath = CLI_PATH): string {
  return `---
name: ${SKILL_NAME}
description: Imports one Claude Code rules file (a CLAUDE.md, CLAUDE.local.md or rules folder file) into Sally, turning its conditional rules into Sally rules the user reviews in Sally's web app, then removes what they published. Run it only when the user asks to import a rules file or their rules into Sally; never start it on your own during other work.
metadata:
  installed-by: sally
---

<!-- Installed by Sally. "sally uninstall" removes it. Change the instructions in Sally's checkout, not here. -->

Read Sally's import instructions at \`${skillInstructionsPath(cliPath)}\` and follow them step by step.

Wherever they say \`sally\`, run Sally's command line from its checkout, since \`sally\` may not be on the PATH:

\`\`\`
node "${cliPath}"
\`\`\`
`;
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

const CLI_FILE = /[\\/]src[\\/]cli\.ts$/;
const IN_SALLY_FOLDER = /[\\/]sally[\\/]src[\\/]cli\.ts$/;

/**
 * Whether `path` is the command line of a Sally checkout, so that a hook
 * running it is Sally's and not a user's own hook that happens to look alike.
 * It is when it is the checkout being installed, when the checkout's package
 * is named sally, or when the checkout is gone and its folder was called sally
 * (a moved or deleted checkout, whose hook would only fail).
 */
function isSallyCli(path: string, cliPath: string): boolean {
  if (path === cliPath) return true;
  if (!CLI_FILE.test(path)) return false;
  if (!existsSync(path)) return IN_SALLY_FOLDER.test(path);
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(dirname(path)), "package.json"), "utf8"));
    return isObject(manifest) && manifest.name === "sally";
  } catch {
    return false;
  }
}

/** Undoes the POSIX quoting earlier installs put around the path. */
function unquote(value: string): string {
  if (!value.startsWith("'") || !value.endsWith("'")) return value;
  return value.slice(1, -1).replaceAll(`'\\''`, "'");
}

/**
 * Whether a hook entry is one of Sally's for `hook`, in either form: the
 * program plus arguments install writes now, or the single shell command
 * line earlier installs wrote (`node <quoted path to cli.ts> hook message`).
 * The path may be another Sally checkout's, so a moved checkout leaves no
 * stale entry.
 */
function isSallyHook(entry: unknown, hook: "message" | "reply", cliPath: string): boolean {
  if (!isObject(entry) || typeof entry.command !== "string") return false;
  if (Array.isArray(entry.args)) {
    const [path, group, name, ...rest] = entry.args as unknown[];
    return (
      entry.command === "node" &&
      rest.length === 0 &&
      typeof path === "string" &&
      group === "hook" &&
      name === hook &&
      isSallyCli(path, cliPath)
    );
  }
  if (entry.args !== undefined) return false;
  const match = /^node (.+) hook (message|reply)$/.exec(entry.command);
  return match !== null && match[2] === hook && isSallyCli(unquote(match[1]!), cliPath);
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
function withoutSallyHooks(groups: unknown[], hook: "message" | "reply", cliPath: string): unknown[] {
  return groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const remaining = group.hooks.filter((entry: unknown) => !isSallyHook(entry, hook, cliPath));
    if (remaining.length === group.hooks.length) return [group];
    return remaining.length === 0 ? [] : [{ ...(group as HookGroup), hooks: remaining }];
  });
}

function sallyHooks(groups: unknown[], hook: "message" | "reply", cliPath: string): unknown[] {
  return groups.flatMap((group) =>
    isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter((entry) => isSallyHook(entry, hook, cliPath)) : [],
  );
}

/**
 * Puts the wanted entry where the first Sally entry was and removes any
 * others, so an install over hooks of the earlier form leaves one set.
 * Groups left empty are dropped.
 */
function replaceSallyHooks(groups: unknown[], hook: "message" | "reply", wanted: HookEntry): unknown[] {
  const cliPath = wanted.args[0]!;
  let placed = false;
  return groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    let changed = false;
    const entries = group.hooks.flatMap((entry: unknown) => {
      if (!isSallyHook(entry, hook, cliPath)) return [entry];
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
 * settings, installs the import skill, and adds the authority line to the
 * global rules file. Running it
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
    const existing = sallyHooks(groups, hook, cliPath ?? CLI_PATH);
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

  const warnings = installSkill(env, cliPath ?? CLI_PATH, changes);

  if (!hasLine(rules, AUTHORITY_LINE)) {
    // A blank line before the authority line, which uninstall takes out again.
    let text = rules;
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    if (text !== "") text += "\n";
    writeRules(rulesPath, text + AUTHORITY_LINE + "\n", changes, "install");
    changes.push(`Added Sally's authority line to ${rulesPath}`);
  }
  return { changes, warnings: [...warnings, ...claudeCodeWarning(claudeVersion)] };
}

const isSallySkill = (path: string) => existsSync(path) && SKILL_MARK.test(readFileSync(path, "utf8"));

/** A warning that a skill of Sally's name is the user's own, and was left alone. */
const notOurs = (folder: string, what: string) =>
  `A skill named ${SKILL_NAME} already exists at ${folder} and is not Sally's, so it was left alone${what}.`;

/**
 * Writes the import skill, or brings Sally's earlier one up to date. A folder
 * of that name without Sally's mark is the user's, and is left alone.
 */
function installSkill(env: Env, cliPath: string, changes: string[]): string[] {
  const path = skillPath(env);
  const folder = dirname(path);
  const content = skillContent(cliPath);
  const ours = isSallySkill(path);
  if (!ours && existsSync(folder) && readdirSync(folder).length > 0) {
    return [notOurs(folder, "; Sally's import skill is not installed")];
  }
  if (ours && readFileSync(path, "utf8") === content) return [];
  writeRules(path, content, changes, "install");
  changes.push(`${ours ? "Updated" : "Installed"} the import skill (/${SKILL_NAME}) at ${path}`);
  return [];
}

/** Removes the import skill if it is Sally's; a skill of that name without Sally's mark stays. */
function uninstallSkill(env: Env, changes: string[]): string[] {
  const path = skillPath(env);
  const folder = dirname(path);
  if (!isSallySkill(path)) {
    return existsSync(folder) && readdirSync(folder).length > 0 ? [notOurs(folder, "")] : [];
  }
  rmSync(path);
  if (readdirSync(folder).length === 0) rmdirSync(folder);
  changes.push(`Removed the import skill (/${SKILL_NAME}) from ${folder}`);
  return [];
}

/**
 * Removes exactly what install added: Sally's two hooks, in either form, from
 * the settings, Sally's import skill, and the authority line from the global
 * rules file.
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
      if (sallyHooks(groups, hook, cliPath ?? CLI_PATH).length === 0) continue;
      const kept = withoutSallyHooks(groups, hook, cliPath ?? CLI_PATH);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      changes.push(`Removed the ${hook} hook (${event}) from ${settingsFile.path}`);
    }
    if (Object.keys(hooks).length === 0 && changes.length > 0) delete settings.hooks;
  }
  if (changes.length > 0) writeSettings(settingsFile);

  const warnings = uninstallSkill(env, changes);

  if (hasLine(rules, AUTHORITY_LINE)) {
    const lines = rules.split("\n");
    const at = lines.findIndex((l) => l.replace(/\r$/, "").trim() === AUTHORITY_LINE);
    lines.splice(at, 1);
    // Take out the blank line install put before it.
    if (at > 0 && lines[at - 1]?.trim() === "") lines.splice(at - 1, 1);
    writeRules(rulesPath, lines.join("\n"), changes, "uninstall");
    changes.push(`Removed Sally's authority line from ${rulesPath}`);
  }
  return { changes, warnings };
}
