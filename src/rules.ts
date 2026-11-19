import { type AnalyticsQueries, createAnalyticsQueries } from "./analytics.ts";
import { type AttentionEntry, type AttentionKind, attentionList, CLEARABLE_KINDS } from "./attention.ts";
import { RuleError, RuleNotFoundError } from "./errors.ts";
import { createFlags, type Flags } from "./flags.ts";
import { conditionFits, estimateTokens, REQUEST_TOKEN_LIMIT, REQUEST_WARNING_SHARE } from "./limits.ts";
import type { Matcher } from "./matcher.ts";
import { rescoreCases, type RescoreResult } from "./rescore.ts";
import { type Store, transaction } from "./store.ts";

export type CheckType = "message" | "reply";

/**
 * Where a rule applies: in every project, or only in the named projects
 * (each named as Sally records it: owner/name, or a folder path).
 */
export type Scope = { kind: "all" } | { kind: "projects"; projects: string[] };

export const ALL_PROJECTS: Readonly<Scope> = Object.freeze({ kind: "all" });

/** The two check types, message first. */
export const CHECK_TYPES: readonly CheckType[] = Object.freeze(["message", "reply"]);

/**
 * Which checks use a condition: a message check uses the conditions on for
 * Message, a reply check those on for Reply. With both off the condition is
 * off and is never scored.
 */
export interface Switches {
  message: boolean;
  reply: boolean;
}

/** A condition of a new rule: its wording and its two switches. */
export interface NewCondition extends Switches {
  text: string;
}

/**
 * A condition in a draft. With an id it is one of the rule's conditions, and
 * `text` is its wording in the draft; a condition that is in a published
 * version keeps its switches, whatever is given here. Without an id it is a
 * new condition, and needs its switches. A condition left out of the draft
 * goes when the draft is published.
 */
export interface DraftCondition {
  id?: number;
  text: string;
  message?: boolean;
  reply?: boolean;
}

export interface NewRule {
  name: string;
  instruction: string;
  conditions: NewCondition[];
  /** All projects when left out. */
  scope?: Scope;
}

/**
 * What a draft holds: the rule's text only. Without a name, the draft keeps
 * the one it has (or the live version's, when it starts a new draft). The
 * scope is not part of a draft: it is set on the rule (see setScope).
 */
export interface DraftContent {
  name?: string;
  instruction: string;
  conditions: DraftCondition[];
}

/** Each condition on for one check type only, as a rule for that one check is written. */
export function conditionsFor(checkType: CheckType, texts: string[]): NewCondition[] {
  return texts.map((text) => ({ text, message: checkType === "message", reply: checkType === "reply" }));
}

/** The check types these conditions are on for, message first. */
export function checkTypesOf(conditions: Switches[]): CheckType[] {
  return CHECK_TYPES.filter((type) => conditions.some((condition) => condition[type]));
}

/** A project Sally has seen a session run in. */
export interface ProjectView {
  name: string;
  firstSeenAt: string;
}

export interface LiveCondition {
  id: number;
  text: string;
}

/** A rule as the engine sees it: its live version only. */
export interface LiveRule {
  ruleId: number;
  name: string;
  versionId: number;
  versionNumber: number;
  instruction: string;
  conditions: LiveCondition[];
}

/**
 * One row of the rules list. `name` is the name in force (the published one, if any).
 * Published, on and has-draft are separate facts: a published rule can be
 * switched off and can have a draft too.
 */
export interface RuleSummary {
  id: number;
  name: string;
  /**
   * The check types the rule takes part in: those its conditions in force (the
   * published version's, or the draft's before the first publish) are on for.
   */
  checkTypes: CheckType[];
  /** True once the rule has a published version. */
  published: boolean;
  /** Where the rule applies. It belongs to the rule, not to a version, and changes at once. */
  scope: Scope;
  /** False once switched off: the engine skips it. A rule switched off before its first publish stays off when published. */
  on: boolean;
  hasDraft: boolean;
}

/** A condition as a version words it, with its switches as they are now (switches are not part of a version). */
export interface ConditionView extends Switches {
  id: number;
  text: string;
}

/** A version's text: its name, instruction and the wording of its conditions. */
export interface VersionView {
  name: string;
  instruction: string;
  conditions: ConditionView[];
}

export interface PublishedVersionView extends VersionView {
  number: number;
  publishedAt: string;
}

export interface DraftView extends VersionView {
  savedAt: string;
}

/** A rule with its live version and its draft side by side, and every published version. */
export interface RuleDetail extends RuleSummary {
  live: PublishedVersionView | null;
  draft: DraftView | null;
  /** Every published version, newest first. Published versions never change. */
  versions: PublishedVersionView[];
}

export interface RuleFilter {
  /** Matches the name, instruction or conditions of the live version or the draft, ignoring case. */
  search?: string;
  /** The rules with a condition in force on for this check type. */
  checkType?: CheckType;
  published?: boolean;
  on?: boolean;
  hasDraft?: boolean;
  /** True for rules for all projects, false for rules for named projects only. */
  allProjects?: boolean;
}

export { RuleError, RuleNotFoundError };

/** The engine's settings. */
export interface Settings {
  /** The score a condition must reach for its rule to match in a message check, 0 to 1. */
  cutoff: number;
  /**
   * The same for a reply check. Apart from the message cutoff because a reply
   * check that matches costs a whole extra reply, and replies often touch a
   * rule's topic without breaking it.
   */
  replyCutoff: number;
  /** How long a check may wait for the matcher before giving up. */
  timeLimitMs: number;
  /**
   * Whether a failed check stops the turn: a failed message check blocks the
   * message, a failed reply check warns the user. Off, the turn goes through
   * without the user's rules.
   */
  stopOnFailure: boolean;
  // The attention thresholds: when a rule is listed as needing attention.
  /** How many of the latest checks count as recent. */
  recentChecks: number;
  /** A rule that matches on at least this share of recent checks, 0 to 1, is listed as matching often. */
  busyShare: number;
  /** A match scoring no more than this above the cutoff, 0 to 1, is a weak match. */
  closeMargin: number;
  /** A rule with no matches over this many checks of its type is listed as never matching. */
  quietChecks: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  cutoff: 0.6,
  replyCutoff: 0.6,
  timeLimitMs: 10_000,
  stopOnFailure: true,
  recentChecks: 100,
  busyShare: 0.3,
  closeMargin: 0.05,
  quietChecks: 200,
});

/** Each setting's key in the settings table. */
const SETTING_KEYS: Record<keyof Settings, string> = {
  cutoff: "cutoff",
  replyCutoff: "reply_cutoff",
  timeLimitMs: "time_limit_ms",
  stopOnFailure: "stop_on_failure",
  recentChecks: "recent_checks",
  busyShare: "busy_share",
  closeMargin: "close_margin",
  quietChecks: "quiet_checks",
};
const SETTINGS = Object.keys(SETTING_KEYS) as (keyof Settings)[];
const SETTING_RANGES: Record<keyof Settings, string> = {
  cutoff: "The cutoff is a score from 0 to 1.",
  replyCutoff: "The reply cutoff is a score from 0 to 1.",
  timeLimitMs: "The time limit is a whole number of milliseconds, from 1 to 10000.",
  stopOnFailure: "Stopping the turn when a check fails is either on or off.",
  recentChecks: "The number of recent checks is a whole number of at least 1.",
  busyShare: "The share of recent checks is a number above 0, up to 1.",
  closeMargin: "The margin above the cutoff is a number from 0 to 1.",
  quietChecks: "The number of checks without a match is a whole number of at least 1.",
};

/** The cutoff a check of this type uses. */
export function cutoffFor(checkType: CheckType, settings: Settings): number {
  return checkType === "reply" ? settings.replyCutoff : settings.cutoff;
}

/** The longest time limit a check may have. */
export const MAX_TIME_LIMIT_MS = 10_000;

function validSetting(key: keyof Settings, value: unknown): boolean {
  if (key === "stopOnFailure") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (key === "cutoff" || key === "replyCutoff" || key === "closeMargin") return value >= 0 && value <= 1;
  if (key === "busyShare") return value > 0 && value <= 1;
  // Two tries at the time limit must fit inside the 30 seconds Claude Code gives a hook.
  if (key === "timeLimitMs") return Number.isInteger(value) && value >= 1 && value <= MAX_TIME_LIMIT_MS;
  return Number.isInteger(value) && value >= 1;
}

/** How much of Jev's per-request limit recent checks have used. */
export interface LimitUse {
  /** Jev's per-request token limit. */
  requestLimit: number;
  /** The share of the limit from which the app warns. */
  warningShare: number;
  /** How many recent checks reported a token count. */
  checks: number;
  /** The most input tokens one request of those checks held; null with no such checks. */
  largestRequest: number | null;
  /** largestRequest as a share of the limit. */
  share: number | null;
  /** True from the warning share up. */
  warning: boolean;
  /** The check that sent the largest request, so it can be found; null with no such checks. */
  largestCheck: LargestCheck | null;
}

/** The check behind the largest recent request, and what took up its room. */
export interface LargestCheck {
  checkId: number;
  createdAt: string;
  checkType: CheckType;
  project: string | null;
  /** The start of the text checked, as sent (it may have been cut to fit). */
  excerpt: string;
  /** How many conditions the text was checked against. */
  conditions: number;
  /** About how much of the request the text took, from 0 to 1; the conditions took the rest. */
  textShare: number;
}

/** How much of the text checked the largest check shows. */
const EXCERPT_LENGTH = 280;

/** The rules service also answers the analytics queries (see analytics.ts) and keeps flags and saved cases (see flags.ts). */
export interface RulesService extends AnalyticsQueries, Flags {
  /** Creates a rule whose only version is a draft. It is not live until published. */
  createRule(rule: NewRule): { ruleId: number };
  /**
   * Replaces the rule's draft with this content, creating the draft if there
   * is none. A draft may be unfinished (no instruction, no conditions) but
   * always has a name no other rule uses. A new condition's switches are set
   * here, and can change with each save until the condition is published.
   */
  saveDraft(ruleId: number, content: DraftContent): void;
  /**
   * Turns the draft into a new live version and returns its number. Its
   * conditions count from now on, each with its switches; conditions the
   * draft left out no longer count.
   */
  publish(ruleId: number): { versionNumber: number };
  /**
   * Scores each of the rule's saved cases with the matcher against the draft's
   * conditions on for the case's check type, and says which cases pass at that
   * check type's cutoff, so the user can see
   * before publishing whether the draft fixes the wrong matches without
   * losing the right ones. Changes nothing and records nothing. A matcher
   * failure is answered as a failed result, never thrown. Refuses a rule with
   * no draft, or a draft that could not be published.
   */
  rescoreDraft(ruleId: number): Promise<RescoreResult>;
  /** Replaces the rule's draft, or starts one, with a copy of the given published version's text. Switches and scope stay as they are. */
  startDraftFrom(ruleId: number, versionNumber: number): void;
  /** Drops the draft, leaving the live version as it is. A rule never published has only its draft: delete it instead. */
  discardDraft(ruleId: number): void;
  /** Switches the rule off: it keeps its versions and draft, and the engine skips it. */
  switchOff(ruleId: number): void;
  /**
   * Switches the rule back on. Refuses a published rule none of whose live
   * conditions is on: a condition has to be switched on first.
   */
  switchOn(ruleId: number): void;
  /**
   * Sets where the rule applies. It takes effect at once, for the next check:
   * it makes no new version and leaves the draft as it is. Refuses a project
   * Sally has not seen, and a list of no projects.
   */
  setScope(ruleId: number, scope: Scope): void;
  /**
   * Sets one switch of a published condition, at once: no draft, no new
   * version, and the next check uses it. Switching off the last live condition
   * that is on switches the rule off in the same change; switching a condition
   * on never switches the rule on. Refuses a condition not yet published,
   * whose switches are set in the draft.
   */
  setConditionSwitch(ruleId: number, conditionId: number, checkType: CheckType, on: boolean): void;
  /** Deletes the rule with all its versions and its draft. */
  deleteRule(ruleId: number): void;
  /**
   * The live version of every rule that is on, in scope for the project and
   * has a live condition on for this check type, with only those conditions,
   * read fresh from the database. Without a project, only rules for all projects.
   */
  liveRules(checkType: CheckType, project?: string): LiveRule[];
  /** Every rule matching the filter, by name. */
  listRules(filter?: RuleFilter): RuleSummary[];
  /** One rule with its live version and its draft. */
  getRule(ruleId: number): RuleDetail;
  /** Every project Sally has seen, by name: the choices for a rule's scope. */
  projects(): ProjectView[];
  /** The stored settings, each falling back to its default. */
  settings(): Settings;
  /** Stores the given settings and returns them all. Refuses a value out of range. */
  updateSettings(changes: Partial<Settings>): Settings;
  /** The rules that need attention under the stored thresholds, worst first, each with why (see attention.ts). */
  attention(): AttentionEntry[];
  /**
   * The user looked at one attention reason of a rule and judged it fine: the
   * reason leaves the list for the rule's live version, and can come back once
   * a new version is published. Refuses wrong matches (those are cleared by
   * fixing the rule), an unknown reason, and a reason the rule is not listed for.
   */
  clearAttentionReason(ruleId: number, kind: AttentionKind, versionNumber?: number): void;
  /** How much of Jev's per-request limit the recent checks have used. */
  limitUse(): LimitUse;
}

const now = () => new Date().toISOString();

/** What a version needs before it can be live. */
function requireComplete(content: { instruction: string; conditions: (Switches & { text: string })[] }): void {
  if (!content.instruction.trim()) throw new RuleError("A rule needs an instruction.");
  const conditions = content.conditions.filter((c) => c.text.trim().length > 0);
  if (conditions.length === 0) throw new RuleError("A rule needs at least one condition.");
  if (!conditions.every((c) => conditionFits(c.text.trim()))) {
    throw new RuleError("A condition is too long for one Jev request.");
  }
  if (checkTypesOf(conditions).length === 0) {
    throw new RuleError("A rule needs at least one condition with its Message or Reply switch on.");
  }
}

const hasSwitches = (condition: DraftCondition): condition is DraftCondition & Switches =>
  typeof condition.message === "boolean" && typeof condition.reply === "boolean";

/** Refuses conditions that are not each a wording, with an id or switches where given. */
function requireConditions(conditions: unknown, needSwitches: boolean): asserts conditions is DraftCondition[] {
  if (!Array.isArray(conditions)) throw new RuleError("A rule's conditions are a list.");
  for (const condition of conditions as unknown[]) {
    const c = condition as Partial<Record<keyof DraftCondition, unknown>> | null;
    const valid =
      typeof c === "object" &&
      c !== null &&
      typeof c.text === "string" &&
      (c.id === undefined || (typeof c.id === "number" && Number.isSafeInteger(c.id))) &&
      (c.message === undefined || typeof c.message === "boolean") &&
      (c.reply === undefined || typeof c.reply === "boolean");
    if (!valid) throw new RuleError("Each condition is its wording, with its Message and Reply switches.");
    if (needSwitches && !hasSwitches(c as DraftCondition)) {
      throw new RuleError("Each condition needs its Message and Reply switches.");
    }
  }
}

function requireScope(scope: unknown): asserts scope is Scope {
  const valid =
    typeof scope === "object" &&
    scope !== null &&
    ((scope as Scope).kind === "all" ||
      ((scope as Scope).kind === "projects" &&
        Array.isArray((scope as { projects?: unknown }).projects) &&
        (scope as { projects: unknown[] }).projects.every((p) => typeof p === "string")));
  if (!valid) throw new RuleError("A rule's scope is all projects or a list of projects.");
}

/** What a scope needs before a rule can have it. */
function requireCompleteScope(scope: Scope): void {
  if (scope.kind === "projects" && scope.projects.length === 0) {
    throw new RuleError("Pick at least one project, or apply the rule to all projects.");
  }
}

function cleanName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) throw new RuleError("A rule needs a name.");
  return cleaned;
}

interface VersionRow {
  id: number;
  number: number | null;
  name: string;
  instruction: string;
  created_at: string;
  published_at: string | null;
}

export interface RulesServiceOptions {
  /** Scores drafts against saved cases. Undefined without an API key; the hooks never need it. */
  matcher?: Matcher;
}

export function createRulesService(db: Store, options: RulesServiceOptions = {}): RulesService {
  /** The ids of these seen projects, without repeats. Refuses a project Sally has not seen. */
  function projectIds(names: string[]): number[] {
    const find = db.prepare("SELECT id FROM projects WHERE name = ?");
    const ids = new Set<number>();
    for (const name of names) {
      const row = find.get(name) as { id: number } | undefined;
      if (!row) throw new RuleError(`Sally has not seen a project named "${name}".`);
      ids.add(row.id);
    }
    return [...ids];
  }

  /**
   * Inserts the draft. A condition with an id the rule has keeps its place as
   * that condition; a new one becomes a condition of the rule, which counts
   * only once a version holding it is published. A condition never published
   * takes the switches given; one in a published version keeps its own.
   */
  function insertDraft(ruleId: number, content: Required<DraftContent>): void {
    const { lastInsertRowid: versionId } = db
      .prepare("INSERT INTO versions (rule_id, number, name, instruction, created_at) VALUES (?, NULL, ?, ?, ?)")
      .run(ruleId, content.name, content.instruction, now());
    const owned = new Set(
      (db.prepare("SELECT id FROM conditions WHERE rule_id = ?").all(ruleId) as { id: number }[]).map((row) => row.id),
    );
    const setSwitches = db.prepare("UPDATE conditions SET message = ?, reply = ? WHERE id = ?");
    const addCondition = db.prepare("INSERT INTO conditions (rule_id, message, reply) VALUES (?, ?, ?)");
    const addWording = db.prepare(
      "INSERT INTO version_conditions (version_id, condition_id, position, text) VALUES (?, ?, ?, ?)",
    );
    const placed = new Set<number>();
    let position = 0;
    for (const condition of content.conditions) {
      const text = condition.text.trim();
      if (!text) continue;
      let id = condition.id;
      if (id !== undefined && owned.has(id)) {
        if (hasSwitches(condition) && !isPublished(id)) {
          setSwitches.run(Number(condition.message), Number(condition.reply), id);
        }
      } else if (hasSwitches(condition)) {
        // An id the rule no longer has, such as a draft-only condition of a discarded
        // draft brought back by undo, is written again as a new condition.
        id = Number(addCondition.run(ruleId, Number(condition.message), Number(condition.reply)).lastInsertRowid);
      } else if (id !== undefined) {
        throw new RuleError(`This rule has no condition ${id}.`);
      } else {
        throw new RuleError("A new condition needs its Message and Reply switches.");
      }
      if (placed.has(id)) throw new RuleError("A condition can be in a draft only once.");
      placed.add(id);
      addWording.run(versionId, id, position++, text);
    }
    dropUnusedConditions(ruleId);
  }

  /** True when a published version, live or older, holds the condition: its switches are no longer the draft's. */
  function isPublished(conditionId: number): boolean {
    return (
      db
        .prepare(
          `SELECT 1 FROM version_conditions vc JOIN versions v ON v.id = vc.version_id
            WHERE vc.condition_id = ? AND v.number IS NOT NULL`,
        )
        .get(conditionId) !== undefined
    );
  }

  /** How many conditions of the rule's live version are on for a check; null for a rule never published. */
  function liveConditionsOn(ruleId: number): number | null {
    const version = live(ruleId);
    if (!version) return null;
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM version_conditions vc JOIN conditions c ON c.id = vc.condition_id
          WHERE vc.version_id = ? AND (c.message = 1 OR c.reply = 1)`,
      )
      .get(version.id) as { count: number };
    return count;
  }

  /** Deletes the rule's conditions that no version holds: those only a replaced or discarded draft had. */
  function dropUnusedConditions(ruleId: number): void {
    db.prepare(
      "DELETE FROM conditions WHERE rule_id = ? AND id NOT IN (SELECT condition_id FROM version_conditions)",
    ).run(ruleId);
  }

  /** The latest of the recent checks with the largest request, with what its text and conditions took. */
  function largestCheck(recentChecks: number): LargestCheck | null {
    const check = db
      .prepare(
        `SELECT c.id, c.created_at, c.check_type, c.text, p.name AS project FROM (
           SELECT id, created_at, check_type, text, project_id, COALESCE(request_tokens, input_tokens) AS tokens
             FROM checks WHERE input_tokens IS NOT NULL ORDER BY id DESC LIMIT ?
         ) c LEFT JOIN projects p ON p.id = c.project_id
         ORDER BY c.tokens DESC, c.id DESC LIMIT 1`,
      )
      .get(recentChecks) as
      | { id: number; created_at: string; check_type: CheckType; text: string; project: string | null }
      | undefined;
    if (!check) return null;
    const conditions = db
      .prepare(
        `SELECT vc.text FROM scores s
           JOIN version_conditions vc ON vc.version_id = s.version_id AND vc.condition_id = s.condition_id
          WHERE s.check_id = ?`,
      )
      .all(check.id) as { text: string }[];
    // Jev reports only the total, so the split is estimated from the lengths.
    const textTokens = estimateTokens(check.text);
    const conditionTokens = conditions.reduce((sum, c) => sum + estimateTokens(c.text), 0);
    return {
      checkId: check.id,
      createdAt: check.created_at,
      checkType: check.check_type,
      project: check.project,
      excerpt: check.text.length > EXCERPT_LENGTH ? `${check.text.slice(0, EXCERPT_LENGTH)}…` : check.text,
      conditions: conditions.length,
      textShare: textTokens + conditionTokens === 0 ? 0 : textTokens / (textTokens + conditionTokens),
    };
  }

  function ruleDetail(ruleId: number): RuleDetail {
    const rule = requireRule(ruleId);
    const versions = published(ruleId).map(publishedView);
    const draftRow = draft(ruleId);
    const draftView = draftRow
      ? {
          savedAt: draftRow.created_at,
          name: draftRow.name,
          instruction: draftRow.instruction,
          conditions: conditionsOf(draftRow.id),
        }
      : null;
    // A rule always has a published version or a draft.
    const inForce = (versions[0] ?? draftView)!;
    return {
      id: ruleId,
      name: rule.name,
      checkTypes: checkTypesOf(inForce.conditions),
      published: versions.length > 0,
      scope: scopeOf(ruleId),
      on: rule.switched_off === 0,
      hasDraft: draftRow !== undefined,
      live: versions[0] ?? null,
      versions,
      draft: draftView,
    };
  }

  function scopeOf(ruleId: number): Scope {
    const { all_projects } = db.prepare("SELECT all_projects FROM rules WHERE id = ?").get(ruleId) as {
      all_projects: number;
    };
    if (all_projects === 1) return { kind: "all" };
    const rows = db
      .prepare(
        `SELECT p.name FROM rule_projects rp JOIN projects p ON p.id = rp.project_id
          WHERE rp.rule_id = ? ORDER BY lower(p.name), p.name`,
      )
      .all(ruleId) as { name: string }[];
    return { kind: "projects", projects: rows.map((row) => row.name) };
  }

  /** Writes the rule's scope; the caller has checked it is complete. */
  function writeScope(ruleId: number, scope: Scope): void {
    const ids = scope.kind === "projects" ? projectIds(scope.projects) : [];
    db.prepare("UPDATE rules SET all_projects = ? WHERE id = ?").run(scope.kind === "all" ? 1 : 0, ruleId);
    db.prepare("DELETE FROM rule_projects WHERE rule_id = ?").run(ruleId);
    const addProject = db.prepare("INSERT INTO rule_projects (rule_id, project_id) VALUES (?, ?)");
    for (const id of ids) addProject.run(ruleId, id);
  }

  function draft(ruleId: number): VersionRow | undefined {
    return db
      .prepare("SELECT id, number, name, instruction, created_at, published_at FROM versions WHERE rule_id = ? AND number IS NULL")
      .get(ruleId) as VersionRow | undefined;
  }

  function live(ruleId: number): VersionRow | undefined {
    return db
      .prepare(
        `SELECT id, number, name, instruction, created_at, published_at FROM versions
          WHERE rule_id = ? AND number IS NOT NULL ORDER BY number DESC LIMIT 1`,
      )
      .get(ruleId) as VersionRow | undefined;
  }

  /** The version's conditions in order: its wording of each, with the condition's switches as they are now. */
  function conditionsOf(versionId: number): ConditionView[] {
    return (
      db
        .prepare(
          `SELECT c.id, vc.text, c.message, c.reply FROM version_conditions vc JOIN conditions c ON c.id = vc.condition_id
            WHERE vc.version_id = ? ORDER BY vc.position`,
        )
        .all(versionId) as { id: number; text: string; message: number; reply: number }[]
    ).map((row) => ({ id: row.id, text: row.text, message: row.message === 1, reply: row.reply === 1 }));
  }

  function published(ruleId: number): VersionRow[] {
    return db
      .prepare(
        `SELECT id, number, name, instruction, created_at, published_at FROM versions
          WHERE rule_id = ? AND number IS NOT NULL ORDER BY number DESC`,
      )
      .all(ruleId) as unknown as VersionRow[];
  }

  function publishedView(row: VersionRow): PublishedVersionView {
    return {
      number: row.number!,
      publishedAt: row.published_at!,
      name: row.name,
      instruction: row.instruction,
      conditions: conditionsOf(row.id),
    };
  }

  function requireRule(ruleId: number): { name: string; switched_off: number } {
    const row = db.prepare("SELECT name, switched_off FROM rules WHERE id = ?").get(ruleId) as
      | { name: string; switched_off: number }
      | undefined;
    if (!row) throw new RuleNotFoundError(`No rule with id ${ruleId}.`);
    return row;
  }

  function setSwitchedOff(ruleId: number, off: boolean): void {
    transaction(db, () => {
      requireRule(ruleId);
      db.prepare("UPDATE rules SET switched_off = ? WHERE id = ?").run(off ? 1 : 0, ruleId);
    });
  }

  /** Replaces the draft, if any, with this content. */
  function replaceDraft(ruleId: number, content: Required<DraftContent>): void {
    requireFreeName(content.name, ruleId);
    const existing = draft(ruleId);
    if (existing) db.prepare("DELETE FROM versions WHERE id = ?").run(existing.id);
    insertDraft(ruleId, content);
    // A rule never published goes by its draft's name.
    if (!live(ruleId)) db.prepare("UPDATE rules SET name = ? WHERE id = ?").run(content.name, ruleId);
  }

  /** Refuses a name that another rule uses, as its name in force or in its draft. */
  function requireFreeName(name: string, ruleId?: number): void {
    const taken = db
      .prepare(
        `SELECT 1 FROM rules WHERE name = ? AND id IS NOT ?
         UNION ALL
         SELECT 1 FROM versions WHERE name = ? AND number IS NULL AND rule_id IS NOT ?`,
      )
      .get(name, ruleId ?? null, name, ruleId ?? null);
    if (taken) throw new RuleError(`A rule named "${name}" already exists.`);
  }

  function readSettings(): Settings {
    const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: number }[];
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const result = { ...DEFAULT_SETTINGS };
    for (const key of SETTINGS) {
      const value = stored.get(SETTING_KEYS[key]);
      if (key === "stopOnFailure") {
        // An on/off setting is stored as 1 or 0.
        if (value === 0 || value === 1) result[key] = value === 1;
      } else if (value !== undefined && validSetting(key, value)) {
        result[key] = value;
      }
    }
    return result;
  }

  const flags = createFlags(db, requireRule);

  return {
    ...createAnalyticsQueries(db, requireRule),
    ...flags,

    createRule(rule) {
      const name = cleanName(rule.name);
      requireConditions(rule.conditions, true);
      requireComplete(rule);
      const scope = rule.scope ?? ALL_PROJECTS;
      requireScope(scope);
      requireCompleteScope(scope);
      return transaction(db, () => {
        requireFreeName(name);
        // A deleted rule's matches and scores stay, so a new rule never takes an
        // id they still name; otherwise SQLite reuses the highest free id.
        const { next } = db
          .prepare(
            `SELECT MAX(COALESCE((SELECT MAX(id) FROM rules), 0),
                        COALESCE((SELECT MAX(rule_id) FROM matches), 0),
                        COALESCE((SELECT MAX(rule_id) FROM scores), 0)) + 1 AS next`,
          )
          .get() as { next: number };
        db.prepare("INSERT INTO rules (id, name, created_at) VALUES (?, ?, ?)").run(next, name, now());
        const ruleId = Number(next);
        writeScope(ruleId, scope);
        insertDraft(ruleId, { name, instruction: rule.instruction, conditions: rule.conditions });
        return { ruleId };
      });
    },

    saveDraft(ruleId, content) {
      requireConditions(content.conditions, false);
      transaction(db, () => {
        const rule = requireRule(ruleId);
        const existing = draft(ruleId);
        const name = content.name === undefined ? (existing?.name ?? rule.name) : cleanName(content.name);
        replaceDraft(ruleId, { name, instruction: content.instruction, conditions: content.conditions });
      });
    },

    startDraftFrom(ruleId, versionNumber) {
      transaction(db, () => {
        requireRule(ruleId);
        const source = published(ruleId).find((row) => row.number === versionNumber);
        if (!source) throw new RuleNotFoundError(`This rule has no version ${versionNumber}.`);
        replaceDraft(ruleId, {
          name: source.name,
          instruction: source.instruction,
          // The wording only: each condition keeps the switches it has now.
          conditions: conditionsOf(source.id).map(({ id, text }) => ({ id, text })),
        });
      });
    },

    discardDraft(ruleId) {
      transaction(db, () => {
        requireRule(ruleId);
        const row = draft(ruleId);
        if (!row) throw new RuleError("This rule has no draft to discard.");
        if (!live(ruleId)) throw new RuleError("This rule has never been published, so its draft is all it has. Delete the rule instead.");
        db.prepare("DELETE FROM versions WHERE id = ?").run(row.id);
        dropUnusedConditions(ruleId);
      });
    },

    switchOff(ruleId) {
      setSwitchedOff(ruleId, true);
    },

    switchOn(ruleId) {
      transaction(db, () => {
        requireRule(ruleId);
        // Conditions switched off on purpose are not switched back on with the rule.
        if (liveConditionsOn(ruleId) === 0) {
          throw new RuleError(
            "None of this rule's conditions is on. Switch a condition's Message or Reply on first, then the rule.",
          );
        }
        setSwitchedOff(ruleId, false);
      });
    },

    setConditionSwitch(ruleId, conditionId, checkType, on) {
      if (!CHECK_TYPES.includes(checkType)) throw new RuleError("A condition's switches are Message and Reply.");
      if (typeof on !== "boolean") throw new RuleError("A switch is on or off.");
      transaction(db, () => {
        const rule = requireRule(ruleId);
        const condition = db
          .prepare("SELECT message, reply FROM conditions WHERE id = ? AND rule_id = ?")
          .get(conditionId, ruleId) as { message: number; reply: number } | undefined;
        if (!condition) throw new RuleNotFoundError(`This rule has no condition ${conditionId}.`);
        if (!isPublished(conditionId)) {
          throw new RuleError("This condition is not published yet. Set its switches in the draft.");
        }
        const wasOn = condition.message === 1 || condition.reply === 1;
        // The column name comes from CHECK_TYPES, never from the caller's text.
        const column = checkType === "message" ? "message" : "reply";
        db.prepare(`UPDATE conditions SET ${column} = ? WHERE id = ?`).run(Number(on), conditionId);
        // The rule's switch tells the truth: with no condition on, the rule is off.
        if (wasOn && !on && rule.switched_off === 0 && liveConditionsOn(ruleId) === 0) {
          db.prepare("UPDATE rules SET switched_off = 1 WHERE id = ?").run(ruleId);
        }
      });
    },

    setScope(ruleId, scope) {
      requireScope(scope);
      requireCompleteScope(scope);
      transaction(db, () => {
        requireRule(ruleId);
        writeScope(ruleId, scope);
      });
    },

    deleteRule(ruleId) {
      transaction(db, () => {
        requireRule(ruleId);
        db.prepare("DELETE FROM rules WHERE id = ?").run(ruleId);
      });
    },

    publish(ruleId) {
      return transaction(db, () => {
        requireRule(ruleId);
        const row = draft(ruleId);
        if (!row) throw new RuleError("This rule has no draft to publish.");
        requireComplete({ instruction: row.instruction, conditions: conditionsOf(row.id) });
        requireFreeName(row.name, ruleId);
        const versionNumber = (live(ruleId)?.number ?? 0) + 1;
        db.prepare("UPDATE versions SET number = ?, published_at = ? WHERE id = ?").run(versionNumber, now(), row.id);
        db.prepare("UPDATE rules SET name = ? WHERE id = ?").run(row.name, ruleId);
        return { versionNumber };
      });
    },

    async rescoreDraft(ruleId) {
      requireRule(ruleId);
      const row = draft(ruleId);
      if (!row) throw new RuleError("This rule has no draft to publish.");
      const conditions = conditionsOf(row.id);
      // The same refusals as publish, so a draft that scores can be published.
      requireComplete({ instruction: row.instruction, conditions });
      requireFreeName(row.name, ruleId);
      // Each case is scored against the draft's conditions for its own check type.
      const settings = readSettings();
      return rescoreCases({
        matcher: options.matcher,
        conditions,
        cases: flags.savedCases(ruleId),
        cutoffs: { message: cutoffFor("message", settings), reply: cutoffFor("reply", settings) },
      });
    },

    liveRules(checkType, project) {
      const rows = db
        .prepare(
          `SELECT r.id AS ruleId, r.name AS name, v.id AS versionId, v.number AS versionNumber,
                  v.instruction AS instruction, c.id AS conditionId, vc.text AS conditionText
             FROM rules r
             JOIN versions v ON v.rule_id = r.id
                            AND v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id)
             JOIN version_conditions vc ON vc.version_id = v.id
             JOIN conditions c ON c.id = vc.condition_id
            WHERE r.switched_off = 0
              AND CASE ? WHEN 'message' THEN c.message WHEN 'reply' THEN c.reply ELSE 0 END = 1
              AND (r.all_projects = 1
                   OR EXISTS (SELECT 1 FROM rule_projects rp JOIN projects p ON p.id = rp.project_id
                               WHERE rp.rule_id = r.id AND p.name = ?))
            ORDER BY r.id, vc.position`,
        )
        .all(checkType, project ?? null) as {
        ruleId: number;
        name: string;
        versionId: number;
        versionNumber: number;
        instruction: string;
        conditionId: number;
        conditionText: string;
      }[];
      const byRule = new Map<number, LiveRule>();
      for (const row of rows) {
        let rule = byRule.get(row.ruleId);
        if (!rule) {
          rule = {
            ruleId: row.ruleId,
            name: row.name,
            versionId: row.versionId,
            versionNumber: row.versionNumber,
            instruction: row.instruction,
            conditions: [],
          };
          byRule.set(row.ruleId, rule);
        }
        rule.conditions.push({ id: row.conditionId, text: row.conditionText });
      }
      return [...byRule.values()];
    },

    listRules(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.checkType === "message") where.push("in_message = 1");
      else if (filter.checkType === "reply") where.push("in_reply = 1");
      else if (filter.checkType !== undefined) throw new RuleError("A check type is message or reply.");
      if (filter.published !== undefined) {
        where.push("published = ?");
        params.push(filter.published ? 1 : 0);
      }
      if (filter.on !== undefined) {
        where.push("switched_off = ?");
        params.push(filter.on ? 0 : 1);
      }
      if (filter.hasDraft !== undefined) {
        where.push("has_draft = ?");
        params.push(filter.hasDraft ? 1 : 0);
      }
      if (filter.allProjects !== undefined) {
        where.push("all_projects = ?");
        params.push(filter.allProjects ? 1 : 0);
      }
      const search = filter.search?.trim();
      if (search) {
        // The live version and the draft count; older versions do not.
        where.push(`EXISTS (
          SELECT 1 FROM versions v
           WHERE v.rule_id = r.id
             AND (v.number IS NULL OR v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id))
             AND (instr(lower(v.name), ?) OR instr(lower(v.instruction), ?)
                  OR EXISTS (SELECT 1 FROM version_conditions vc
                              WHERE vc.version_id = v.id AND instr(lower(vc.text), ?))))`);
        const needle = search.toLowerCase();
        params.push(needle, needle, needle);
      }
      const onFor = (column: "message" | "reply") =>
        `EXISTS (SELECT 1 FROM version_conditions vc JOIN conditions c ON c.id = vc.condition_id
                  WHERE vc.version_id = v.id AND c.${column} = 1)`;
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT r.id, r.name, r.switched_off,
                    EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NOT NULL) AS published,
                    EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NULL) AS has_draft,
                    r.all_projects,
                    ${onFor("message")} AS in_message, ${onFor("reply")} AS in_reply
               FROM rules r
               -- The version in force: the latest published, else the draft.
               JOIN versions v ON v.id = (SELECT id FROM versions WHERE rule_id = r.id
                                           ORDER BY number IS NULL, number DESC LIMIT 1)) r
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY lower(name), id`,
        )
        .all(...params) as {
        id: number;
        name: string;
        switched_off: number;
        published: number;
        has_draft: number;
        in_message: number;
        in_reply: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        checkTypes: checkTypesOf([{ message: row.in_message === 1, reply: row.in_reply === 1 }]),
        published: row.published === 1,
        scope: scopeOf(row.id),
        on: row.switched_off === 0,
        hasDraft: row.has_draft === 1,
      }));
    },

    getRule(ruleId) {
      // In one transaction, so a publish in between cannot leave it with neither
      // a published version nor a draft.
      return transaction(db, () => ruleDetail(ruleId));
    },

    projects() {
      const rows = db
        .prepare("SELECT name, first_seen_at FROM projects ORDER BY lower(name), name")
        .all() as { name: string; first_seen_at: string }[];
      return rows.map((row) => ({ name: row.name, firstSeenAt: row.first_seen_at }));
    },

    settings: readSettings,

    limitUse() {
      const { recentChecks } = readSettings();
      // Checks recorded before the largest request was kept had only one request.
      const row = db
        .prepare(
          `SELECT COUNT(tokens) AS checks, MAX(tokens) AS largest FROM (
             SELECT COALESCE(request_tokens, input_tokens) AS tokens FROM checks
             WHERE input_tokens IS NOT NULL ORDER BY id DESC LIMIT ?
           )`,
        )
        .get(recentChecks) as { checks: number; largest: number | null };
      const share = row.largest === null ? null : row.largest / REQUEST_TOKEN_LIMIT;
      return {
        requestLimit: REQUEST_TOKEN_LIMIT,
        warningShare: REQUEST_WARNING_SHARE,
        checks: row.checks,
        largestRequest: row.largest,
        share,
        warning: share !== null && share >= REQUEST_WARNING_SHARE,
        largestCheck: largestCheck(recentChecks),
      };
    },

    updateSettings(changes) {
      const entries = SETTINGS.filter((key) => changes[key] !== undefined).map((key) => [key, changes[key]!] as const);
      for (const [key, value] of entries) {
        if (!validSetting(key, value)) throw new RuleError(SETTING_RANGES[key]);
      }
      transaction(db, () => {
        const save = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        );
        for (const [key, value] of entries) save.run(SETTING_KEYS[key], typeof value === "boolean" ? Number(value) : value);
      });
      return readSettings();
    },

    attention() {
      return attentionList(db, readSettings());
    },

    clearAttentionReason(ruleId, kind, versionNumber) {
      requireRule(ruleId);
      if (kind === "wrong_matches") {
        throw new RuleError("Wrong matches cannot be cleared this way: fix the rule and publish a new version.");
      }
      if (!CLEARABLE_KINDS.includes(kind)) throw new RuleError("No such attention reason.");
      const version = live(ruleId);
      // The user judged the version they were shown; a newer one has not been looked at.
      if (versionNumber !== undefined && version?.number !== versionNumber) {
        throw new RuleError("This rule has a newer version than the one listed. Refresh the list and look again.");
      }
      // Clearing twice is fine; clearing a reason the rule is not listed for is not.
      const already =
        version !== undefined &&
        db.prepare("SELECT 1 FROM cleared_reasons WHERE version_id = ? AND kind = ?").get(version.id, kind) !== undefined;
      if (already) return;
      const entry = attentionList(db, readSettings()).find((e) => e.ruleId === ruleId);
      if (!version || !entry?.reasons.some((reason) => reason.kind === kind)) {
        throw new RuleError("This rule is not listed for that reason.");
      }
      db.prepare("INSERT INTO cleared_reasons (version_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(
        version.id,
        kind,
        now(),
      );
    },
  };
}
