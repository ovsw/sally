// The last step of an import: taking the published rules out of the rules
// file. The skill does the editing in Claude Code; this gives it what it needs
// around that: which rules were published, a backup of the rules file, and a
// record that the removal happened. It only reads the user's decisions; making
// them belongs to the import service and the web app.
import { constants, copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RuleError, RuleNotFoundError } from "./errors.ts";
import type { ImportService, PassageVerdict, ProposedRuleDecision } from "./import.ts";
import { dataDir, type Env } from "./paths.ts";
import type { Scope } from "./rules.ts";
import { type Store, transaction } from "./store.ts";

/**
 * What the removal does to a passage: take all of it out of the rules file,
 * take out only the part its published rules cover, or leave it.
 */
export type PassageRemoval = "all" | "part" | "none";

export interface RemovalRule {
  /** The proposal's id, which stays when a skipped rule is deleted. */
  proposalId: number;
  /** The rule it created; null once skipped. */
  ruleId: number | null;
  /** The live version's name when published, else the draft's; null once skipped. */
  name: string | null;
  /** The user's decision: published, kept as a draft, skipped, or not decided yet. */
  decision: ProposedRuleDecision;
  /** Whether the rule has a live version now. */
  live: boolean;
  /**
   * Whether the rule is switched on. Only rules live and on leave the rules
   * file: the hooks skip a switched-off rule, so its passage still does the work.
   */
  on: boolean;
  /** What the live version says, else the draft; null once skipped. */
  instruction: string | null;
  conditions: string[];
}

export interface RemovalPassage {
  position: number;
  /** The passage's text as it stood in the rules file when the import began. */
  text: string;
  verdict: PassageVerdict;
  /** The user's overrule of the verdict, if any. */
  decision: "becomes_rule" | "stays" | null;
  /** Whether the passage stays in the rules file, by the verdict or the user's overrule. */
  stays: boolean;
  pending: boolean;
  removal: PassageRemoval;
  rules: RemovalRule[];
}

export interface RemovalReport {
  id: number;
  rulesFile: string;
  scope: Scope;
  createdAt: string;
  removedAt: string | null;
  passageCount: number;
  pendingCount: number;
  /** Passages to take out of the rules file whole, by position: every rule from them is live and on. */
  removeAll: number[];
  /** Passages to take out only in part, by position: the part covered by rules not live and on stays. */
  removePart: number[];
  /** In file order. */
  passages: RemovalPassage[];
}

/** An import with the user's decisions, in the shape the skill uses to work out what to remove. */
export function removalReport(imports: ImportService, importId: number): RemovalReport {
  const detail = imports.getImport(importId);
  const passages = detail.passages.map((passage): RemovalPassage => {
    const rules = passage.rules.map((proposal): RemovalRule => {
      const version = proposal.rule?.live ?? proposal.rule?.draft ?? null;
      return {
        proposalId: proposal.id,
        ruleId: proposal.ruleId,
        name: version?.name ?? null,
        decision: proposal.decision,
        live: proposal.rule?.live != null,
        on: proposal.rule?.on ?? false,
        instruction: version?.instruction ?? null,
        conditions: version?.conditions ?? [],
      };
    });
    const inEffect = rules.filter((rule) => rule.live && rule.on).length;
    const removal: PassageRemoval = inEffect === 0 ? "none" : inEffect === rules.length ? "all" : "part";
    const stays = (passage.decision ?? (passage.verdict === "becomes_rule" ? "becomes_rule" : "stays")) === "stays";
    return {
      position: passage.position,
      text: passage.text,
      verdict: passage.verdict,
      decision: passage.decision,
      stays,
      pending: passage.pending,
      removal,
      rules,
    };
  });
  return {
    id: detail.id,
    rulesFile: detail.rulesFile,
    scope: detail.scope,
    createdAt: detail.createdAt,
    removedAt: detail.removedAt,
    passageCount: detail.passageCount,
    pendingCount: detail.pendingCount,
    removeAll: passages.filter((p) => p.removal === "all").map((p) => p.position),
    removePart: passages.filter((p) => p.removal === "part").map((p) => p.position),
    passages,
  };
}

/**
 * Records that the published rules were taken out of the import's rules file,
 * or that the user closed the import without taking any out. Recording it
 * again keeps the first time.
 */
export function recordRemoval(db: Store, importId: number): { id: number; removedAt: string } {
  return transaction(db, () => {
    const row = db.prepare("SELECT removed_at FROM imports WHERE id = ?").get(importId) as
      | { removed_at: string | null }
      | undefined;
    if (!row) throw new RuleNotFoundError(`No import with id ${importId}.`);
    if (row.removed_at !== null) return { id: importId, removedAt: row.removed_at };
    const removedAt = new Date().toISOString();
    db.prepare("UPDATE imports SET removed_at = ? WHERE id = ?").run(removedAt, importId);
    return { id: importId, removedAt };
  });
}

/** The folder in Sally's data folder that holds every backup of a rules file. */
export function backupDir(env: Env): string {
  return join(dataDir(env), "backups");
}

/** A name part made of letters, digits, dots, dashes and underscores only. */
function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "rules";
}

/**
 * Copies a rules file into Sally's data folder under a dated name, such as
 * `2026-11-18-shop-CLAUDE.md`, and returns both paths. A second backup on the
 * same day gets `-2`, then `-3`, and never overwrites the first. Backups never
 * go beside the rules file, so none can be committed by accident.
 */
export function backupRulesFile(env: Env, rulesFile: string, today = new Date()): { rulesFile: string; backup: string } {
  if (typeof rulesFile !== "string" || !rulesFile.trim()) throw new RuleError("Name the rules file to back up.");
  const path = resolve(rulesFile);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    // No such file: refused below.
  }
  if (!isFile) throw new RuleError(`There is no rules file at ${path}.`);
  const folder = backupDir(env);
  mkdirSync(folder, { recursive: true });
  const date = today.toISOString().slice(0, 10);
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const base = `${date}-${safe(basename(dirname(path)))}-${safe(stem)}`;
  for (let copy = 1; ; copy++) {
    const backup = join(folder, `${base}${copy === 1 ? "" : `-${copy}`}${extension && safe(extension)}`);
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      return { rulesFile: path, backup };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
