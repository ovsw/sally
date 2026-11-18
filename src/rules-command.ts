// `node src/cli.ts rules ...`: the command line for agents. An agent can read rules and
// prepare drafts here; publishing, switching off and deleting stay with the
// user in the web app. Everything goes through the rules service, so a draft
// made here is the same draft the app shows.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { databasePath, type Env } from "./paths.ts";
import {
  type CheckType,
  createRulesService,
  type DraftContent,
  RuleError,
  type RuleFilter,
  type RulesService,
  type RuleState,
} from "./rules.ts";
import { openStore } from "./store.ts";

export interface CommandIo {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const RULES_USAGE = `Usage:
  node src/cli.ts rules list [--search TEXT] [--check-type message|reply] [--state live|draft]
                             [--with-draft | --without-draft]
  node src/cli.ts rules show RULE
  node src/cli.ts rules create --name NAME --check-type message|reply --instruction TEXT
                               --condition TEXT [--condition TEXT ...]
  node src/cli.ts rules edit RULE [--name NAME] [--check-type message|reply]
                                  [--instruction TEXT] [--condition TEXT ...]

RULE is a rule's id or its exact name. Output is JSON.
create makes a draft; edit changes the rule's draft, starting one from the
live version if there is none. --condition replaces all of the draft's
conditions. Publishing, switching off and deleting a rule are done by the user
in Sally's web app, not by these commands.
`;

/** Commands an agent might try that are reserved for the user in the app. */
export const RESERVED: Record<string, string> = {
  publish: "Publishing",
  "switch-off": "Switching off",
  off: "Switching off",
  disable: "Switching off",
  delete: "Deleting",
  remove: "Deleting",
  rm: "Deleting",
};

export class UsageError extends Error {}

const CHECK_TYPES: readonly CheckType[] = ["message", "reply"];
const STATES: readonly RuleState[] = ["live", "draft"];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} is one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function onePositional(positionals: string[], command: string): string {
  if (positionals.length !== 1) throw new UsageError(`rules ${command} takes one rule: its id or its name.`);
  return positionals[0]!;
}

function noPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) throw new UsageError(`rules ${command} takes no rule; got "${positionals[0]}".`);
}

/** Finds a rule by its id or by its exact name in force. */
function resolveRule(rules: RulesService, ref: string): number {
  if (/^\d+$/.test(ref)) return rules.getRule(Number(ref)).id;
  const match = rules.listRules().find((rule) => rule.name === ref);
  if (!match) throw new RuleError(`No rule named "${ref}".`);
  return match.id;
}

export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

const editOptions = {
  name: { type: "string" },
  "check-type": { type: "string" },
  instruction: { type: "string" },
  condition: { type: "string", multiple: true },
} as const;

function list(rules: RulesService, args: string[]): unknown {
  const { values, positionals } = parse(args, {
    search: { type: "string" },
    "check-type": { type: "string" },
    state: { type: "string" },
    "with-draft": { type: "boolean" },
    "without-draft": { type: "boolean" },
  });
  noPositionals(positionals, "list");
  if (values["with-draft"] && values["without-draft"]) {
    throw new UsageError("Use --with-draft or --without-draft, not both.");
  }
  const filter: RuleFilter = {
    search: values.search,
    checkType: oneOf(values["check-type"], CHECK_TYPES, "--check-type"),
    state: oneOf(values.state, STATES, "--state"),
    hasDraft: values["with-draft"] ? true : values["without-draft"] ? false : undefined,
  };
  return rules.listRules(filter);
}

function show(rules: RulesService, args: string[]): unknown {
  const { positionals } = parse(args, {});
  return rules.getRule(resolveRule(rules, onePositional(positionals, "show")));
}

function create(rules: RulesService, args: string[]): unknown {
  const { values, positionals } = parse(args, editOptions);
  noPositionals(positionals, "create");
  const missing = (["name", "check-type", "instruction", "condition"] as const).filter((key) => values[key] === undefined);
  if (missing.length > 0) throw new UsageError(`rules create needs ${missing.map((key) => `--${key}`).join(", ")}.`);
  const { ruleId } = rules.createRule({
    name: values.name!,
    checkType: oneOf(values["check-type"], CHECK_TYPES, "--check-type")!,
    instruction: values.instruction!,
    conditions: values.condition!,
  });
  return rules.getRule(ruleId);
}

function edit(rules: RulesService, args: string[]): unknown {
  const { values, positionals } = parse(args, editOptions);
  const ruleId = resolveRule(rules, onePositional(positionals, "edit"));
  if (Object.values(values).every((value) => value === undefined)) {
    throw new UsageError("rules edit needs at least one of --name, --check-type, --instruction, --condition.");
  }
  const checkType = oneOf(values["check-type"], CHECK_TYPES, "--check-type");
  const rule = rules.getRule(ruleId);
  // Start from the draft, or from the live version when there is no draft.
  const base = rule.draft ?? rule.live!;
  const content: DraftContent = {
    name: values.name,
    checkType,
    instruction: values.instruction ?? base.instruction,
    conditions: values.condition ?? base.conditions,
  };
  rules.saveDraft(ruleId, content);
  return rules.getRule(ruleId);
}

const COMMANDS: Record<string, (rules: RulesService, args: string[]) => unknown> = { list, show, create, edit };

/** Runs `node src/cli.ts rules <command> ...` and returns the exit code. */
export function runRulesCommand(args: string[], io: CommandIo): number {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? io.stderr : io.stdout)(RULES_USAGE);
    return command === undefined ? 1 : 0;
  }
  const reserved = RESERVED[command];
  if (reserved) {
    io.stderr(
      `rules ${command}: ${reserved} a rule is done by the user in Sally's web app, not from the command line. ` +
        "These commands can list and show rules, and create or edit drafts. Nothing was changed.\n",
    );
    return 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    io.stderr(`Unknown command "rules ${command}".\n\n${RULES_USAGE}`);
    return 1;
  }
  let store;
  try {
    store = openStore(databasePath(io.env));
    io.stdout(json(run(createRulesService(store), rest)));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${RULES_USAGE}`);
      return 1;
    }
    if (error instanceof RuleError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}
