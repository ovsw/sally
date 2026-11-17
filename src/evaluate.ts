// `sally evaluate FILE`: measures how well the engine matches on real text.
// It runs every saved message and reply in the evaluation file through the
// engine with the real Jev matcher, against the file's rules in a throwaway
// database, and compares what matched with what was expected. It needs an API
// key and costs a little, so it runs only on request and never in CI.
// The evaluation file's format is described in docs/evaluation.md.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createEngine, type Outcome } from "./engine.ts";
import { PADDING_AVAILABLE, paddingConditions } from "./evaluation-padding.ts";
import { createJevMatcher } from "./jev.ts";
import type { Matcher } from "./matcher.ts";
import { type Env, readApiKey } from "./paths.ts";
import { type CheckType, createRulesService, DEFAULT_SETTINGS, RuleError, type Settings } from "./rules.ts";
import { openStore } from "./store.ts";

/** How many conditions the scale run pads each check type to, unless told otherwise. */
export const DEFAULT_SCALE_CONDITIONS = 400;

export const EVALUATE_USAGE = `Usage:
  sally evaluate FILE [--scale] [--conditions N] [--cutoff X]
                      [--time-limit MS] [--json]

Runs every case in the evaluation file through the engine with the real Jev
matcher and reports right matches, wrong matches and misses, with timing and
tokens. It needs an API key and costs a little.

--scale          pads the rules of each check type to several hundred
                 conditions with made-up ones that should never match, and
                 reports the wrong-match rate as the headline number
--conditions N   how many conditions the scale run pads to (default ${DEFAULT_SCALE_CONDITIONS});
                 implies --scale
--cutoff, --time-limit
                 the engine settings to run with (defaults ${DEFAULT_SETTINGS.cutoff}, ${DEFAULT_SETTINGS.timeLimitMs})
--json           prints the full results as JSON

The file's format is described in docs/evaluation.md. It holds private
messages, so keep it outside the repository.
`;

/** The instruction given to rules that leave it out, and to padding rules. Jev never sees it. */
const PLACEHOLDER_INSTRUCTION = "(Not used by the evaluation.)";

export interface EvaluateIo {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Replaces the Jev matcher built from the API key; tests pass a stand-in. */
  matcher?: Matcher;
}

interface EvalRule {
  name: string;
  check: CheckType;
  conditions: string[];
  instruction?: string;
}

interface EvalCase {
  label: string;
  check: CheckType;
  text: string;
  expected: string[];
}

interface EvalFile {
  rules: EvalRule[];
  cases: EvalCase[];
  padding: Partial<Record<CheckType, string[]>>;
}

interface ScoredRule {
  name: string;
  /** The rule's best condition score in the check; null when it was not scored. */
  score: number | null;
  /** True for a padding rule of the scale run. */
  padding: boolean;
}

export interface CaseResult {
  label: string;
  check: CheckType;
  outcome: Outcome;
  error: string | null;
  /** Rules attached or sent back, strongest first. */
  matched: ScoredRule[];
  right: ScoredRule[];
  wrong: ScoredRule[];
  missed: ScoredRule[];
  durationMs: number;
  inputTokens: number | null;
}

export interface EvaluationReport {
  scale: boolean;
  settings: { cutoff: number; timeLimitMs: number };
  /** Conditions in the rule set per check type, and how many of them are padding. */
  conditions: Record<CheckType, { total: number; padding: number }>;
  summary: {
    cases: number;
    /** Cases whose check did not fail. Right, wrong and missed count only these. */
    completed: number;
    failed: number;
    skipped: number;
    right: number;
    wrong: number;
    missed: number;
    /** Completed checks that asked Jev, that is neither failed nor skipped. */
    ran: number;
    /** Checks that ran with at least one wrong match. */
    checksWithWrongMatch: number;
    /** checksWithWrongMatch as a share of the checks that ran; null when none ran. */
    wrongMatchRate: number | null;
    /** Timing and tokens cover only the checks that ran. */
    durationMs: { median: number | null; mean: number | null; max: number | null };
    inputTokens: { total: number | null; largestCheck: number | null };
  };
  cases: CaseResult[];
}

class UsageError extends Error {}

const CHECK_TYPES: readonly CheckType[] = ["message", "reply"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function checkType(value: unknown, where: string): CheckType {
  if (!CHECK_TYPES.includes(value as CheckType)) throw new UsageError(`${where}: "check" is "message" or "reply".`);
  return value as CheckType;
}

/** Reads and checks the evaluation file, so that a mistake in it stops the run before Jev is called. */
export function parseEvaluationFile(source: string): EvalFile {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new UsageError(`The evaluation file is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isObject(data)) throw new UsageError("The evaluation file holds one JSON object with rules and cases.");
  if (!Array.isArray(data.rules) || data.rules.length === 0) {
    throw new UsageError('The evaluation file needs a non-empty "rules" list.');
  }
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    throw new UsageError('The evaluation file needs a non-empty "cases" list.');
  }

  const rules: EvalRule[] = data.rules.map((rule: unknown, index: number) => {
    const where = `Rule ${index + 1}`;
    if (!isObject(rule)) throw new UsageError(`${where} is not an object.`);
    if (typeof rule.name !== "string" || !rule.name.trim()) throw new UsageError(`${where} needs a "name".`);
    const named = `Rule "${rule.name}"`;
    if (!isStringArray(rule.conditions) || rule.conditions.length === 0) {
      throw new UsageError(`${named} needs a non-empty "conditions" list of strings.`);
    }
    if (rule.instruction !== undefined && typeof rule.instruction !== "string") {
      throw new UsageError(`${named}: "instruction" is a string.`);
    }
    return { name: rule.name.trim(), check: checkType(rule.check, named), conditions: rule.conditions, instruction: rule.instruction };
  });
  const byName = new Map<string, EvalRule>();
  for (const rule of rules) {
    if (byName.has(rule.name)) throw new UsageError(`Two rules are named "${rule.name}".`);
    byName.set(rule.name, rule);
  }

  const cases: EvalCase[] = data.cases.map((item: unknown, index: number) => {
    const where = `Case ${index + 1}`;
    if (!isObject(item)) throw new UsageError(`${where} is not an object.`);
    if (item.label !== undefined && typeof item.label !== "string") throw new UsageError(`${where}: "label" is a string.`);
    const label = item.label?.trim() || `#${index + 1}`;
    const named = item.label ? `Case "${label}"` : where;
    const check = checkType(item.check, named);
    if (typeof item.text !== "string" || !item.text.trim()) throw new UsageError(`${named} needs a "text".`);
    if (!isStringArray(item.expected)) throw new UsageError(`${named} needs an "expected" list of rule names (empty when none should match).`);
    for (const name of item.expected) {
      const rule = byName.get(name);
      if (!rule) throw new UsageError(`${named} expects a rule the file does not have: "${name}".`);
      if (rule.check !== check) throw new UsageError(`${named} is a ${check} check but expects the ${rule.check} rule "${name}".`);
    }
    return { label, check, text: item.text, expected: [...new Set(item.expected)] };
  });

  const padding: EvalFile["padding"] = {};
  if (data.padding !== undefined) {
    if (!isObject(data.padding)) throw new UsageError('"padding" is an object with "message" and "reply" lists.');
    for (const type of CHECK_TYPES) {
      const list = data.padding[type];
      if (list === undefined) continue;
      if (!isStringArray(list)) throw new UsageError(`"padding.${type}" is a list of conditions.`);
      padding[type] = list;
    }
  }
  return { rules, cases, padding };
}

function number(value: string | undefined, flag: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new UsageError(`${flag} takes ${integer ? "a whole number" : "a number"}.`);
  }
  return parsed;
}

interface Options {
  file: string;
  scaleConditions: number | null;
  settings: Partial<Settings>;
  json: boolean;
}

function parseOptions(args: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        scale: { type: "boolean" },
        conditions: { type: "string" },
        cutoff: { type: "string" },
        "time-limit": { type: "string" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new UsageError("sally evaluate takes one evaluation file.");
  const conditions = number(values.conditions, "--conditions", true);
  if (conditions !== undefined && conditions < 1) throw new UsageError("--conditions takes a whole number of at least 1.");
  const settings: Partial<Settings> = {};
  const cutoff = number(values.cutoff, "--cutoff", false);
  const timeLimitMs = number(values["time-limit"], "--time-limit", true);
  if (cutoff !== undefined) settings.cutoff = cutoff;
  if (timeLimitMs !== undefined) settings.timeLimitMs = timeLimitMs;
  return {
    file: positionals[0]!,
    scaleConditions: conditions ?? (values.scale ? DEFAULT_SCALE_CONDITIONS : null),
    settings,
    json: values.json === true,
  };
}

/** The padding conditions that bring each check type with cases up to `target` conditions. */
function padding(file: EvalFile, target: number): Record<CheckType, string[]> {
  const result: Record<CheckType, string[]> = { message: [], reply: [] };
  for (const type of CHECK_TYPES) {
    if (!file.cases.some((c) => c.check === type)) continue;
    const have = file.rules.filter((r) => r.check === type).reduce((sum, r) => sum + r.conditions.length, 0);
    const needed = Math.max(0, target - have);
    if (needed === 0) continue;
    const own = file.padding[type];
    if (own) {
      if (own.length < needed) {
        throw new UsageError(`The scale run needs ${needed} ${type} padding conditions; the file gives ${own.length}.`);
      }
      result[type] = own.slice(0, needed);
    } else {
      if (needed > PADDING_AVAILABLE) {
        throw new UsageError(
          `The scale run needs ${needed} ${type} padding conditions; there are ${PADDING_AVAILABLE} built in. Give more under "padding" in the file.`,
        );
      }
      result[type] = paddingConditions(type, needed);
    }
  }
  return result;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Runs the evaluation in a throwaway database and returns its report. */
export async function evaluate(
  file: EvalFile,
  matcher: Matcher,
  options: { scaleConditions: number | null; settings: Partial<Settings> },
): Promise<EvaluationReport> {
  const pads = options.scaleConditions === null ? { message: [], reply: [] } : padding(file, options.scaleConditions);
  // Never the user's database: the rules and checks live in a temporary folder that is removed afterwards.
  const dir = mkdtempSync(join(tmpdir(), "sally-evaluate-"));
  const store = openStore(join(dir, "sally.db"));
  try {
    const rules = createRulesService(store);
    const settings = rules.updateSettings(options.settings);

    const names = new Map<number, { name: string; padding: boolean }>();
    const add = (name: string, check: CheckType, conditions: string[], instruction: string, isPadding: boolean) => {
      let ruleId: number;
      try {
        ruleId = rules.createRule({ name, checkType: check, conditions, instruction }).ruleId;
      } catch (error) {
        if (error instanceof RuleError) throw new UsageError(`Rule "${name}": ${error.message}`);
        throw error;
      }
      rules.publish(ruleId);
      names.set(ruleId, { name, padding: isPadding });
    };
    for (const rule of file.rules) {
      add(rule.name, rule.check, rule.conditions, rule.instruction?.trim() || PLACEHOLDER_INSTRUCTION, false);
    }
    for (const type of CHECK_TYPES) {
      pads[type].forEach((condition, index) => {
        add(`Padding ${type} ${String(index + 1).padStart(3, "0")}`, type, [condition], PLACEHOLDER_INSTRUCTION, true);
      });
    }

    const conditions = Object.fromEntries(
      CHECK_TYPES.map((type) => [
        type,
        {
          total: file.rules.filter((r) => r.check === type).reduce((sum, r) => sum + r.conditions.length, 0) + pads[type].length,
          padding: pads[type].length,
        },
      ]),
    ) as EvaluationReport["conditions"];

    const engine = createEngine({ store, rules, matcher });
    const checkRow = store.prepare("SELECT duration_ms, input_tokens, error FROM checks WHERE id = ?");
    const bestScores = store.prepare("SELECT rule_id, MAX(score) AS score FROM scores WHERE check_id = ? GROUP BY rule_id");
    const cases: CaseResult[] = [];
    for (const item of file.cases) {
      const result = await engine.check({ checkType: item.check, text: item.text, sessionId: "evaluation" });
      const row = checkRow.get(result.checkId) as { duration_ms: number; input_tokens: number | null; error: string | null };
      const best = new Map<string, number>();
      for (const s of bestScores.all(result.checkId) as { rule_id: number; score: number }[]) {
        best.set(names.get(s.rule_id)!.name, s.score);
      }
      const scored = (name: string, isPadding: boolean): ScoredRule => ({ name, score: best.get(name) ?? null, padding: isPadding });
      const matched = result.matches.map((f) => scored(f.name, names.get(f.ruleId)!.padding));
      const failed = result.outcome === "failed";
      const expected = new Set(item.expected);
      const matchedNames = new Set(matched.map((f) => f.name));
      cases.push({
        label: item.label,
        check: item.check,
        outcome: result.outcome,
        error: row.error,
        matched,
        right: failed ? [] : matched.filter((f) => expected.has(f.name)),
        wrong: failed ? [] : matched.filter((f) => !expected.has(f.name)),
        missed: failed ? [] : item.expected.filter((name) => !matchedNames.has(name)).map((name) => scored(name, false)),
        durationMs: row.duration_ms,
        inputTokens: row.input_tokens,
      });
    }

    const completed = cases.filter((c) => c.outcome !== "failed");
    // A skipped check never asks Jev, so it would drag down the timing, empty the
    // token total and dilute the wrong-match rate. Those use only the checks that ran.
    const ran = completed.filter((c) => c.outcome !== "skipped");
    const sum = (pick: (c: CaseResult) => number) => completed.reduce((total, c) => total + pick(c), 0);
    const durations = ran.map((c) => c.durationMs);
    const tokens = ran.map((c) => c.inputTokens);
    const knownTokens = tokens.every((t) => t !== null) && tokens.length > 0 ? (tokens as number[]) : null;
    const checksWithWrongMatch = ran.filter((c) => c.wrong.length > 0).length;
    return {
      scale: options.scaleConditions !== null,
      settings: { cutoff: settings.cutoff, timeLimitMs: settings.timeLimitMs },
      conditions,
      summary: {
        cases: cases.length,
        completed: completed.length,
        failed: cases.length - completed.length,
        skipped: cases.filter((c) => c.outcome === "skipped").length,
        right: sum((c) => c.right.length),
        wrong: sum((c) => c.wrong.length),
        missed: sum((c) => c.missed.length),
        ran: ran.length,
        checksWithWrongMatch,
        wrongMatchRate: ran.length > 0 ? checksWithWrongMatch / ran.length : null,
        durationMs: {
          median: median(durations),
          mean: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
          max: durations.length > 0 ? Math.max(...durations) : null,
        },
        inputTokens: {
          total: knownTokens ? knownTokens.reduce((a, b) => a + b, 0) : null,
          largestCheck: knownTokens ? Math.max(...knownTokens) : null,
        },
      },
      cases,
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const score = (value: number | null) => (value === null ? "not scored" : value.toFixed(2));
const count = (value: number | null) => (value === null ? "unknown" : value.toLocaleString("en-US"));

/** The report as text for a person to read. */
export function formatReport(report: EvaluationReport): string {
  const { summary, settings, conditions } = report;
  const lines: string[] = [];
  const rate =
    summary.wrongMatchRate === null
      ? "Wrong-match rate: no checks ran"
      : `Wrong-match rate: ${percent(summary.wrongMatchRate)} (${summary.checksWithWrongMatch} of ${summary.ran} checks that ran had a wrong match)`;
  const counts = `Right matches: ${summary.right}   Wrong matches: ${summary.wrong}   Misses: ${summary.missed}`;

  const messages = report.cases.filter((c) => c.check === "message").length;
  lines.push(
    `${report.scale ? "Scale run" : "Evaluation"}: ${summary.cases} cases (${messages} messages, ${summary.cases - messages} replies)`,
  );
  lines.push(
    `Conditions: ${conditions.message.total} message, ${conditions.reply.total} reply` +
      (report.scale ? ` (padding: ${conditions.message.padding} message, ${conditions.reply.padding} reply)` : ""),
  );
  lines.push(`Cutoff ${settings.cutoff}, time limit ${settings.timeLimitMs} ms`, "");
  // The scale run exists to measure wrong matches, so its headline comes first.
  if (report.scale) lines.push(rate, counts);
  else lines.push(counts, rate);
  lines.push(`Failed: ${summary.failed}   Skipped: ${summary.skipped}`);
  const d = summary.durationMs;
  lines.push(
    d.median === null ? "Time per check: no checks ran" : `Time per check: median ${d.median} ms, mean ${d.mean} ms, max ${d.max} ms`,
  );
  lines.push(
    `Input tokens: ${count(summary.inputTokens.total)} in all, at most ${count(summary.inputTokens.largestCheck)} in one check`,
  );

  const section = (title: string, rows: string[]) => {
    if (rows.length > 0) lines.push("", title, ...rows.map((row) => `  ${row}`));
  };
  const at = (c: CaseResult) => `${c.label} (${c.check})`;
  section(
    "Wrong matches",
    report.cases.flatMap((c) => c.wrong.map((r) => `${at(c)}: "${r.name}"${r.padding ? " [padding]" : ""} scored ${score(r.score)}`)),
  );
  section("Misses", report.cases.flatMap((c) => c.missed.map((r) => `${at(c)}: "${r.name}" best score ${score(r.score)}`)));
  section("Failed checks", report.cases.filter((c) => c.outcome === "failed").map((c) => `${at(c)}: ${c.error ?? "unknown error"}`));
  return lines.join("\n") + "\n";
}

/** The evaluate command. Returns its exit code. */
export async function runEvaluation(args: string[], io: EvaluateIo): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    io.stdout(EVALUATE_USAGE);
    return 0;
  }
  try {
    const options = parseOptions(args);
    let source: string;
    try {
      source = readFileSync(options.file, "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read ${options.file}: ${error instanceof Error ? error.message : error}`);
    }
    const file = parseEvaluationFile(source);
    let matcher = io.matcher;
    if (!matcher) {
      const apiKey = readApiKey(io.env);
      if (!apiKey) {
        throw new UsageError("The evaluation calls Jev and needs an API key: set TYPESAFE_API_KEY or put it in ~/.config/sally/api_key.");
      }
      matcher = createJevMatcher({ apiKey });
    }
    const report = await evaluate(file, matcher, options);
    io.stdout(options.json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof RuleError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
