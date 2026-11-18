// `sally import ...`: the command line the import skill calls. It starts an
// import for a rules file and adds the passages the skill found, each with its
// verdict, reason and proposed rules, which become drafts. Publishing stays
// with the user in the web app. Once the user has decided, show reports what
// was published, backup copies the rules file into Sally's data folder, and
// removed records that the skill took the published rules out of the file.
import { readFileSync } from "node:fs";
import { createImportService, type ImportService, type NewPassage } from "./import.ts";
import { backupRulesFile, recordRemoval, removalReport } from "./import-removal.ts";
import { databasePath } from "./paths.ts";
import { type CommandIo, json, parse, RESERVED, UsageError } from "./rules-command.ts";
import { RuleError } from "./rules.ts";
import { openStore, type Store } from "./store.ts";

export interface ImportCommandIo extends CommandIo {
  /** Reads all of standard input. */
  readStdin: () => Promise<string>;
}

export const IMPORT_USAGE = `Usage:
  sally import start RULES_FILE
  sally import add IMPORT [--file PATH]
  sally import show IMPORT
  sally import list
  sally import backup RULES_FILE
  sally import removed IMPORT

IMPORT is an import's id, as start prints it. Output is JSON.
start begins an import for one rules file. Its rules apply to all projects when
the file is in the user's Claude Code folder, and to the file's project
otherwise.
add reads passages as JSON from PATH, or from standard input without --file
(or with --file -), and adds them after the import's last passage, in order.
The JSON is a list of passages, or an object with a "passages" list:
  [{ "text": "the passage as it stands in the rules file",
     "verdict": "becomes_rule" | "always_rule" | "too_vague",
     "reason": "why, written as a lesson",
     "similarRule": "optional note: looks like an existing rule",
     "rules": [{ "name": "...", "checkType": "message" | "reply",
                 "instruction": "...", "conditions": ["..."] }] }]
A passage that becomes a rule has one or more rules; one that stays has none.
checkType is message when left out. Each rule is created as a draft. Either
all the passages are added or none is.
show prints the import with the user's decisions. Each passage has "removal":
"all" when every rule it produced is live, so the whole passage can leave the
rules file; "part" when only some are, so the rest of it stays; "none"
otherwise. Each rule has its "decision" (published, kept, skipped, or null when
not decided yet) and "live". "removeAll" and "removePart" list the positions.
backup copies a rules file into Sally's data folder under a dated name, never
beside the rules file, and prints both paths. A second backup on the same day
gets its own name.
removed records that the published rules were taken out of the import's rules
file (or that the user chose to take none out).
Publishing a rule is done by the user in Sally's web app, not by these
commands.
`;

function importId(positionals: string[], command: string): number {
  if (positionals.length !== 1) throw new UsageError(`sally import ${command} takes one import: its id.`);
  const id = Number(positionals[0]);
  if (!Number.isSafeInteger(id) || id < 1) throw new UsageError(`An import's id is a whole number; got "${positionals[0]}".`);
  return id;
}

function noPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) throw new UsageError(`sally import ${command} takes nothing more; got "${positionals[0]}".`);
}

/** The passages in the JSON given to add: a list, or an object holding one under "passages". */
function passagesFrom(input: string, source: string): NewPassage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new RuleError(`The passages from ${source} are not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const passages =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { passages?: unknown }).passages
      : parsed;
  if (!Array.isArray(passages)) {
    throw new RuleError(`The passages from ${source} must be a JSON list, or an object with a "passages" list.`);
  }
  return passages as NewPassage[];
}

type Command = (imports: ImportService, args: string[], io: ImportCommandIo, store: Store) => unknown;

const COMMANDS: Record<string, Command> = {
  start(imports, args) {
    const { positionals } = parse(args, {});
    if (positionals.length !== 1) throw new UsageError("sally import start takes one rules file: its path.");
    return imports.startImport(positionals[0]!);
  },
  async add(imports, args, io) {
    const { values, positionals } = parse(args, { file: { type: "string" } });
    const id = importId(positionals, "add");
    const file = values.file;
    let input: string;
    if (file === undefined || file === "-") {
      input = await io.readStdin();
    } else {
      try {
        input = readFileSync(file, "utf8");
      } catch {
        throw new RuleError(`Cannot read the passages file ${file}.`);
      }
    }
    const source = file === undefined || file === "-" ? "standard input" : file;
    return imports.addPassages(id, passagesFrom(input, source));
  },
  show(imports, args) {
    const { positionals } = parse(args, {});
    return removalReport(imports, importId(positionals, "show"));
  },
  list(imports, args) {
    noPositionals(parse(args, {}).positionals, "list");
    return { imports: imports.listImports() };
  },
  backup(_imports, args, io) {
    const { positionals } = parse(args, {});
    if (positionals.length !== 1) throw new UsageError("sally import backup takes one rules file: its path.");
    return backupRulesFile(io.env, positionals[0]!);
  },
  removed(_imports, args, _io, store) {
    const { positionals } = parse(args, {});
    return recordRemoval(store, importId(positionals, "removed"));
  },
};

/** Runs `sally import <command> ...` and returns the exit code. */
export async function runImportCommand(args: string[], io: ImportCommandIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    (command === undefined ? io.stderr : io.stdout)(IMPORT_USAGE);
    return command === undefined ? 1 : 0;
  }
  const reserved = RESERVED[command];
  if (reserved) {
    io.stderr(
      `sally import ${command}: ${reserved} a rule is done by the user in Sally's web app, not from the command line. ` +
        "These commands can start an import, add its passages, show it, back up its rules file and record the removal. Nothing was changed.\n",
    );
    return 1;
  }
  const run = COMMANDS[command];
  if (!run) {
    io.stderr(`Unknown command "sally import ${command}".\n\n${IMPORT_USAGE}`);
    return 1;
  }
  let store;
  try {
    store = openStore(databasePath(io.env));
    io.stdout(json(await run(createImportService(store, { env: io.env }), rest, io, store)));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${IMPORT_USAGE}`);
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
