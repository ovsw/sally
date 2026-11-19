// The import: turning the conditional rules in one rules file into drafts.
// The skill splits the file into passages and proposes a verdict, a reason and
// rules for each; the user reviews them in the web app. This lives beside the
// rules service and goes through it for every rule, so the hooks, which load
// only the rules service, never load any of it.
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { RuleError, RuleNotFoundError } from "./errors.ts";
import { claudeDir, type Env } from "./paths.ts";
import { resolveProject } from "./project.ts";
import {
  type CheckType,
  conditionsFor,
  createRulesService,
  type NewRule,
  type RuleDetail,
  type RulesService,
  type Scope,
} from "./rules.ts";
import { type Store, transaction } from "./store.ts";

/**
 * What the import proposes for a passage: it becomes a rule; it stays in the
 * rules file as an always-rule; or it stays because it is too vague to match on.
 */
export type PassageVerdict = "becomes_rule" | "always_rule" | "too_vague";

export const PASSAGE_VERDICTS: readonly PassageVerdict[] = ["becomes_rule", "always_rule", "too_vague"];

/** The user's overrule of a verdict: write rules for the passage, or leave it in the file. */
export type PassageDecision = "becomes_rule" | "stays";

/**
 * Where a proposed rule stands: published (it has a live version), kept as a
 * draft, skipped (its draft was deleted), or not decided yet (null).
 */
export type ProposedRuleDecision = "published" | "kept" | "skipped" | null;

/** A rule the import proposes for a passage. Its scope comes from the rules file. */
export interface ProposedRule {
  name: string;
  /** The message check when left out. */
  checkType?: CheckType;
  instruction: string;
  conditions: string[];
}

export interface NewPassage {
  /** The passage's original text, as it stands in the rules file. */
  text: string;
  verdict: PassageVerdict;
  /** Why, written as a lesson. */
  reason: string;
  /** A note when the passage looks like a rule Sally already has. */
  similarRule?: string;
  /** At least one when the verdict is becomes_rule; none otherwise. */
  rules?: ProposedRule[];
}

export interface ProposedRuleView {
  /** The proposal's own id, which stays when a skipped rule is deleted. */
  id: number;
  /** The rule it created; null once skipped. */
  ruleId: number | null;
  decision: ProposedRuleDecision;
  /** The rule as it is now; null once skipped. */
  rule: RuleDetail | null;
}

export interface PassageView {
  id: number;
  /** Its place in the rules file: 1 for the first passage. */
  position: number;
  text: string;
  verdict: PassageVerdict;
  reason: string;
  similarRule: string | null;
  decision: PassageDecision | null;
  seenAt: string | null;
  /** Until every rule it produced is decided, or, for a passage that stays, until the user has seen it. */
  pending: boolean;
  rules: ProposedRuleView[];
}

export interface ImportSummary {
  id: number;
  /** The rules file's absolute path. */
  rulesFile: string;
  /** The scope its rules get: all projects for a user-level rules file, else its project. */
  scope: Scope;
  createdAt: string;
  /** When the published rules were removed from the rules file; null until then. */
  removedAt: string | null;
  passageCount: number;
  pendingCount: number;
}

export interface ImportDetail extends ImportSummary {
  /** In file order. */
  passages: PassageView[];
}

/**
 * The user's decisions in an import. Every one answers with the import as it
 * now is. A proposed rule is named by its proposal id (ProposedRuleView.id),
 * a passage by its id. Editing a proposed rule's conditions and instruction is
 * saving its draft through the rules service, as on the rule screen.
 *
 * Changing a decision afterwards:
 * - a rule kept as a draft can still be edited, published or skipped;
 * - a published rule is live: the import cannot keep or skip it; it is
 *   changed, switched off or deleted on its rule screen;
 * - a skipped rule's draft is gone, so it cannot come back: the user writes a
 *   new rule for the passage instead;
 * - a passage marked as staying can get a rule written for it, and a passage
 *   given a written rule can be marked as staying again.
 */
export interface ImportDecisions {
  /** Publishes the proposed rule's draft. A rule already published with no draft is left as it is. Refuses a skipped rule. */
  publishProposedRule(proposalId: number): ImportDetail;
  /** Leaves the proposed rule as a draft and settles it for the import. Refuses a skipped or live rule. */
  keepProposedRule(proposalId: number): ImportDetail;
  /**
   * Deletes the proposed rule, which was never live, and settles it for the
   * import. Skipping a skipped rule changes nothing. Refuses a live rule.
   */
  skipProposedRule(proposalId: number): ImportDetail;
  /**
   * Writes a rule for the passage, as a draft with the import's scope, after
   * its other rules. Overrules a verdict that the passage stays: it now
   * becomes a rule.
   */
  writeRule(passageId: number, rule: Omit<NewRule, "scope">): ImportDetail;
  /**
   * Overrules the verdict the other way: the passage stays in the rules file,
   * and its rules not yet published are skipped. Refuses a passage with a live
   * rule, which would then be both in the file and in Sally.
   */
  markPassageStays(passageId: number): ImportDetail;
  /** Records that the user has seen the passage; a passage that stays is pending until then. */
  markPassageSeen(passageId: number): ImportDetail;
}

export interface ImportService extends ImportDecisions {
  /**
   * Starts an import for the rules file at this path. A rules file in the
   * user's Claude Code folder gives its rules to all projects; any other gives
   * them to the project it sits in. Refuses a path with no file.
   */
  startImport(rulesFile: string): ImportSummary;
  /**
   * Adds passages after the import's last one, in the order given, creating
   * each proposed rule as a draft linked to its passage. All or nothing.
   */
  addPassages(importId: number, passages: NewPassage[]): ImportDetail;
  /** One import with its passages and the rules they produced. */
  getImport(importId: number): ImportDetail;
  /** Every import, newest first. */
  listImports(): ImportSummary[];
}

export interface ImportServiceOptions {
  /** Where the user's Claude Code folder is. */
  env: Env;
  /** The rules service to create drafts through; one on the same store when left out. */
  rules?: RulesService;
}

const now = () => new Date().toISOString();

/** The real path, following links, when it exists; otherwise the path as given. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The folder whose project a rules file belongs to: the folder holding its
 * `.claude` folder when it sits in one (such as `.claude/CLAUDE.md` or
 * `.claude/rules/...`), so a project outside git is its own folder, as the
 * hooks see it; otherwise the folder it sits in.
 */
function projectFolderOf(rulesFile: string): string {
  const parts = dirname(rulesFile).split(sep);
  const at = parts.lastIndexOf(".claude");
  return at > 0 ? parts.slice(0, at).join(sep) || sep : dirname(rulesFile);
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RuleError(`${what} needs text.`);
  return value;
}

function requirePassage(passage: NewPassage, index: number): void {
  const which = `Passage ${index + 1}`;
  if (typeof passage !== "object" || passage === null) throw new RuleError(`${which} is not a passage.`);
  requireText(passage.text, `${which}'s text`);
  requireText(passage.reason, `${which}'s reason`);
  if (!PASSAGE_VERDICTS.includes(passage.verdict)) {
    throw new RuleError(`${which}'s verdict is one of: ${PASSAGE_VERDICTS.join(", ")}.`);
  }
  if (passage.similarRule !== undefined && typeof passage.similarRule !== "string") {
    throw new RuleError(`${which}'s similar-rule note must be text.`);
  }
  const rules = passage.rules ?? [];
  if (!Array.isArray(rules)) throw new RuleError(`${which}'s rules must be a list.`);
  if (passage.verdict === "becomes_rule" && rules.length === 0) {
    throw new RuleError(`${which} becomes a rule, so it needs at least one proposed rule.`);
  }
  if (passage.verdict !== "becomes_rule" && rules.length > 0) {
    throw new RuleError(`${which} stays in the rules file, so it proposes no rules.`);
  }
  rules.forEach((rule, ruleIndex) => {
    const whichRule = `${which}, rule ${ruleIndex + 1}`;
    if (typeof rule !== "object" || rule === null) throw new RuleError(`${whichRule} is not a rule.`);
    if (typeof rule.name !== "string") throw new RuleError(`${whichRule} needs a name.`);
    if (typeof rule.instruction !== "string") throw new RuleError(`${whichRule} needs an instruction.`);
    if (!Array.isArray(rule.conditions) || !rule.conditions.every((c) => typeof c === "string")) {
      throw new RuleError(`${whichRule}'s conditions must be a list of text.`);
    }
  });
}

interface ImportRow {
  id: number;
  rules_file: string;
  all_projects: number;
  project: string | null;
  created_at: string;
  removed_at: string | null;
}

interface PassageRow {
  id: number;
  position: number;
  text: string;
  verdict: PassageVerdict;
  reason: string;
  similar_rule: string | null;
  decision: PassageDecision | null;
  seen_at: string | null;
}

interface ProposalRow {
  id: number;
  rule_id: number | null;
  decision: "kept" | "skipped" | null;
}

export function createImportService(db: Store, options: ImportServiceOptions): ImportService {
  const rules = options.rules ?? createRulesService(db);

  /** The scope a rules file's rules get, recording its project if Sally has not seen it. */
  function scopeFor(rulesFile: string): Scope {
    // By where Claude Code loads it from, or where it really is: either may be a link.
    const folder = claudeDir(options.env);
    if (isInside(resolve(folder), rulesFile) || isInside(realPath(folder), realPath(rulesFile))) return { kind: "all" };
    const project = resolveProject(projectFolderOf(rulesFile));
    db.prepare("INSERT INTO projects (name, first_seen_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING").run(
      project,
      now(),
    );
    return { kind: "projects", projects: [project] };
  }

  function requireImport(importId: number): ImportRow {
    const row = db
      .prepare(
        `SELECT i.id, i.rules_file, i.all_projects, p.name AS project, i.created_at, i.removed_at
           FROM imports i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?`,
      )
      .get(importId) as ImportRow | undefined;
    if (!row) throw new RuleNotFoundError(`No import with id ${importId}.`);
    return row;
  }

  function scopeOf(row: ImportRow): Scope {
    return row.all_projects === 1 ? { kind: "all" } : { kind: "projects", projects: [row.project!] };
  }

  function proposalView(row: ProposalRow): ProposedRuleView {
    if (row.rule_id === null) return { id: row.id, ruleId: null, decision: "skipped", rule: null };
    const rule = rules.getRule(row.rule_id);
    return {
      id: row.id,
      ruleId: row.rule_id,
      decision: rule.live !== null ? "published" : row.decision,
      rule,
    };
  }

  function passageView(row: PassageRow): PassageView {
    const proposals = (
      db
        .prepare("SELECT id, rule_id, decision FROM passage_rules WHERE passage_id = ? ORDER BY position")
        .all(row.id) as unknown as ProposalRow[]
    ).map(proposalView);
    const stays = (row.decision ?? (row.verdict === "becomes_rule" ? "becomes_rule" : "stays")) === "stays";
    const pending = stays
      ? row.seen_at === null
      : proposals.length === 0 || proposals.some((proposal) => proposal.decision === null);
    return {
      id: row.id,
      position: row.position,
      text: row.text,
      verdict: row.verdict,
      reason: row.reason,
      similarRule: row.similar_rule,
      decision: row.decision,
      seenAt: row.seen_at,
      pending,
      rules: proposals,
    };
  }

  function passagesOf(importId: number): PassageView[] {
    return (
      db
        .prepare(
          `SELECT id, position, text, verdict, reason, similar_rule, decision, seen_at
             FROM passages WHERE import_id = ? ORDER BY position`,
        )
        .all(importId) as unknown as PassageRow[]
    ).map(passageView);
  }

  function detail(row: ImportRow): ImportDetail {
    const passages = passagesOf(row.id);
    return {
      id: row.id,
      rulesFile: row.rules_file,
      scope: scopeOf(row),
      createdAt: row.created_at,
      removedAt: row.removed_at,
      passageCount: passages.length,
      pendingCount: passages.filter((passage) => passage.pending).length,
      passages,
    };
  }

  function summary(row: ImportRow): ImportSummary {
    const full: Partial<ImportDetail> = detail(row);
    delete full.passages;
    return full as ImportSummary;
  }

  return {
    startImport(rulesFile) {
      requireText(rulesFile, "An import's rules file");
      const path = resolve(rulesFile);
      let isFile = false;
      try {
        isFile = statSync(path).isFile();
      } catch {
        // No such file: refused below.
      }
      if (!isFile) throw new RuleError(`There is no rules file at ${resolve(rulesFile)}.`);
      // Outside the transaction: finding the project may wait on git.
      const scope = scopeFor(path);
      return transaction(db, () => {
        const projectId =
          scope.kind === "all"
            ? null
            : (db.prepare("SELECT id FROM projects WHERE name = ?").get(scope.projects[0]!) as { id: number }).id;
        const { lastInsertRowid } = db
          .prepare("INSERT INTO imports (rules_file, all_projects, project_id, created_at) VALUES (?, ?, ?, ?)")
          .run(path, scope.kind === "all" ? 1 : 0, projectId, now());
        return summary(requireImport(Number(lastInsertRowid)));
      });
    },

    addPassages(importId, passages) {
      if (!Array.isArray(passages) || passages.length === 0) throw new RuleError("Add at least one passage.");
      passages.forEach(requirePassage);
      return transaction(db, () => {
        const row = requireImport(importId);
        if (row.removed_at !== null) throw new RuleError("This import's removal has happened; start a new import.");
        const scope = scopeOf(row);
        const { last } = db
          .prepare("SELECT COALESCE(MAX(position), 0) AS last FROM passages WHERE import_id = ?")
          .get(importId) as { last: number };
        const addPassage = db.prepare(
          `INSERT INTO passages (import_id, position, text, verdict, reason, similar_rule)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const addProposal = db.prepare("INSERT INTO passage_rules (passage_id, position, rule_id) VALUES (?, ?, ?)");
        passages.forEach((passage, index) => {
          const { lastInsertRowid: passageId } = addPassage.run(
            importId,
            last + index + 1,
            passage.text,
            passage.verdict,
            passage.reason,
            passage.similarRule?.trim() || null,
          );
          (passage.rules ?? []).forEach((proposed, position) => {
            let ruleId: number;
            try {
              ({ ruleId } = rules.createRule({
                name: proposed.name,
                instruction: proposed.instruction,
                conditions: conditionsFor(proposed.checkType ?? "message", proposed.conditions),
                scope,
              }));
            } catch (error) {
              if (!(error instanceof RuleError)) throw error;
              throw new RuleError(`Passage ${index + 1}, rule ${position + 1}: ${error.message}`);
            }
            addProposal.run(passageId, position, ruleId);
          });
        });
        return detail(row);
      });
    },

    getImport(importId) {
      return detail(requireImport(importId));
    },

    listImports() {
      return (
        db
          .prepare(
            `SELECT i.id, i.rules_file, i.all_projects, p.name AS project, i.created_at, i.removed_at
               FROM imports i LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.id DESC`,
          )
          .all() as unknown as ImportRow[]
      ).map(summary);
    },

    ...decisions(db, rules, scopeOf, requireImport, detail),
  };
}

interface DecisionPassageRow {
  id: number;
  import_id: number;
  verdict: PassageVerdict;
  decision: PassageDecision | null;
}

interface DecisionProposalRow {
  id: number;
  passage_id: number;
  import_id: number;
  rule_id: number | null;
}

/** The user's decisions in an import (see ImportDecisions), over the import service's own reads. */
function decisions(
  db: Store,
  rules: RulesService,
  scopeOf: (row: ImportRow) => Scope,
  requireImport: (importId: number) => ImportRow,
  detail: (row: ImportRow) => ImportDetail,
): ImportDecisions {
  const answer = (importId: number) => detail(requireImport(importId));

  function findPassage(passageId: number): DecisionPassageRow {
    const row = db
      .prepare("SELECT id, import_id, verdict, decision FROM passages WHERE id = ?")
      .get(passageId) as DecisionPassageRow | undefined;
    if (!row) throw new RuleNotFoundError(`No passage with id ${passageId}.`);
    return row;
  }

  function findProposal(proposalId: number): DecisionProposalRow {
    const row = db
      .prepare(
        `SELECT pr.id, pr.passage_id, p.import_id, pr.rule_id
           FROM passage_rules pr JOIN passages p ON p.id = pr.passage_id WHERE pr.id = ?`,
      )
      .get(proposalId) as DecisionProposalRow | undefined;
    if (!row) throw new RuleNotFoundError(`No proposed rule with id ${proposalId}.`);
    return row;
  }

  const SKIPPED = "This rule was skipped, so its draft is gone. Write a new rule for the passage instead.";
  const isLive = (ruleId: number) => rules.getRule(ruleId).live !== null;

  const settle = (proposalId: number, decision: "kept" | "skipped") =>
    db
      .prepare("UPDATE passage_rules SET decision = ?, decided_at = ? WHERE id = ?")
      .run(decision, now(), proposalId);

  /** Deletes the proposal's draft rule and records it as skipped. */
  function skip(proposal: { id: number; rule_id: number | null }): void {
    if (proposal.rule_id !== null) rules.deleteRule(proposal.rule_id);
    db.prepare("UPDATE passage_rules SET rule_id = NULL WHERE id = ?").run(proposal.id);
    settle(proposal.id, "skipped");
  }

  // Each decision reads what it checks and makes its change in one write
  // transaction, so a change committed by another process in between (the
  // command line, or a second app) cannot slip past the check.
  return {
    publishProposedRule(proposalId) {
      return transaction(db, () => {
        const proposal = findProposal(proposalId);
        if (proposal.rule_id === null) throw new RuleError(SKIPPED);
        const rule = rules.getRule(proposal.rule_id);
        if (rule.live === null || rule.draft !== null) rules.publish(proposal.rule_id);
        return answer(proposal.import_id);
      });
    },

    keepProposedRule(proposalId) {
      return transaction(db, () => {
        const proposal = findProposal(proposalId);
        if (proposal.rule_id === null) throw new RuleError(SKIPPED);
        if (isLive(proposal.rule_id)) {
          throw new RuleError("This rule is published already. Change it, switch it off or delete it in Rules.");
        }
        settle(proposal.id, "kept");
        return answer(proposal.import_id);
      });
    },

    skipProposedRule(proposalId) {
      return transaction(db, () => {
        const proposal = findProposal(proposalId);
        if (proposal.rule_id !== null) {
          if (isLive(proposal.rule_id)) {
            throw new RuleError("This rule is published, so skipping cannot remove it. Delete it in Rules instead.");
          }
          skip(proposal);
        }
        return answer(proposal.import_id);
      });
    },

    writeRule(passageId, proposed) {
      if (typeof proposed !== "object" || proposed === null) throw new RuleError("Send the rule to write.");
      return transaction(db, () => {
        const passage = findPassage(passageId);
        const { ruleId } = rules.createRule({
          name: proposed.name,
          instruction: proposed.instruction,
          conditions: proposed.conditions,
          scope: scopeOf(requireImport(passage.import_id)),
        });
        const { next } = db
          .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM passage_rules WHERE passage_id = ?")
          .get(passageId) as { next: number };
        db.prepare("INSERT INTO passage_rules (passage_id, position, rule_id) VALUES (?, ?, ?)").run(
          passageId,
          next,
          ruleId,
        );
        const stays = (passage.decision ?? (passage.verdict === "becomes_rule" ? "becomes_rule" : "stays")) === "stays";
        if (stays) db.prepare("UPDATE passages SET decision = 'becomes_rule' WHERE id = ?").run(passageId);
        return answer(passage.import_id);
      });
    },

    markPassageStays(passageId) {
      return transaction(db, () => {
        const passage = findPassage(passageId);
        const proposals = db
          .prepare("SELECT id, rule_id FROM passage_rules WHERE passage_id = ? ORDER BY position")
          .all(passageId) as unknown as { id: number; rule_id: number | null }[];
        if (proposals.some((proposal) => proposal.rule_id !== null && isLive(proposal.rule_id))) {
          throw new RuleError(
            "A rule from this passage is published, so the passage cannot also stay in the rules file. Delete that rule in Rules first.",
          );
        }
        for (const proposal of proposals) if (proposal.rule_id !== null) skip(proposal);
        db.prepare("UPDATE passages SET decision = 'stays', seen_at = COALESCE(seen_at, ?) WHERE id = ?").run(
          now(),
          passageId,
        );
        return answer(passage.import_id);
      });
    },

    markPassageSeen(passageId) {
      const passage = findPassage(passageId);
      db.prepare("UPDATE passages SET seen_at = ? WHERE id = ? AND seen_at IS NULL").run(now(), passageId);
      return answer(passage.import_id);
    },
  };
}
