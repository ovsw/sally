import { type AnalyticsQueries, createAnalyticsQueries } from "./analytics.ts";
import { RuleError, RuleNotFoundError } from "./errors.ts";
import { createFlags, type Flags } from "./flags.ts";
import { type Store, transaction } from "./store.ts";

export type CheckType = "message" | "reply";

/**
 * Where a rule applies: in every project, or only in the named projects
 * (each named as Sally records it: owner/name, or a folder path).
 */
export type Scope = { kind: "all" } | { kind: "projects"; projects: string[] };

export const ALL_PROJECTS: Readonly<Scope> = Object.freeze({ kind: "all" });

export interface RuleContent {
  instruction: string;
  conditions: string[];
}

export interface NewRule extends RuleContent {
  name: string;
  checkType: CheckType;
  /** All projects when left out. */
  scope?: Scope;
}

/**
 * What a draft holds. Without a name or a scope, the draft keeps the one it
 * has (or the live version's, when it starts a new draft).
 */
export interface DraftContent extends RuleContent {
  name?: string;
  scope?: Scope;
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
 * A rule is live once published; until then it has only its draft. A
 * published rule that is switched off is "off": it keeps its history, and the
 * engine skips it.
 */
export type RuleState = "live" | "draft" | "off";

/** One row of the rules list. `name` is the name in force (the live one, if any). */
export interface RuleSummary {
  id: number;
  name: string;
  checkType: CheckType;
  state: RuleState;
  /** False once switched off. A rule switched off before its first publish stays off when published. */
  on: boolean;
  hasDraft: boolean;
}

export interface VersionView {
  name: string;
  instruction: string;
  conditions: string[];
  scope: Scope;
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
  checkType?: CheckType;
  /** One state, or any of several. */
  state?: RuleState | RuleState[];
  hasDraft?: boolean;
}

export { RuleError, RuleNotFoundError };

/** The engine's settings. */
export interface Settings {
  /** The score a condition must reach for its rule to fire, 0 to 1. */
  cutoff: number;
  /** The most rules attached in one check. */
  cap: number;
  /** How long a check may wait for the matcher before giving up. */
  timeLimitMs: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ cutoff: 0.6, cap: 3, timeLimitMs: 3000 });

/** Each setting's key in the settings table. */
const SETTING_KEYS: Record<keyof Settings, string> = { cutoff: "cutoff", cap: "cap", timeLimitMs: "time_limit_ms" };
const SETTINGS = Object.keys(SETTING_KEYS) as (keyof Settings)[];
const SETTING_RANGES: Record<keyof Settings, string> = {
  cutoff: "The cutoff is a score from 0 to 1.",
  cap: "The cap is a whole number of at least 1.",
  timeLimitMs: "The time limit is a whole number of milliseconds, at least 1.",
};

function validSetting(key: keyof Settings, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (key === "cutoff") return value >= 0 && value <= 1;
  return Number.isInteger(value) && value >= 1;
}

/** The rules service also answers the analytics queries (see analytics.ts) and keeps flags and saved cases (see flags.ts). */
export interface RulesService extends AnalyticsQueries, Flags {
  /** Creates a rule whose only version is a draft. It is not live until published. */
  createRule(rule: NewRule): { ruleId: number };
  /**
   * Replaces the rule's draft with this content, creating the draft if there
   * is none. A draft may be unfinished (no instruction, no conditions) but
   * always has a name no other rule uses.
   */
  saveDraft(ruleId: number, content: DraftContent): void;
  /** Turns the draft into a new live version and returns its number. */
  publish(ruleId: number): { versionNumber: number };
  /** Replaces the rule's draft, or starts one, with a copy of the given published version. */
  startDraftFrom(ruleId: number, versionNumber: number): void;
  /** Drops the draft, leaving the live version as it is. A rule never published has only its draft: delete it instead. */
  discardDraft(ruleId: number): void;
  /** Switches the rule off: it keeps its versions and draft, and the engine skips it. */
  switchOff(ruleId: number): void;
  /** Switches the rule back on. */
  switchOn(ruleId: number): void;
  /** Deletes the rule with all its versions and its draft. */
  deleteRule(ruleId: number): void;
  /**
   * The live version of every rule of this check type that is on and in scope
   * for the project, read fresh from the database. Without a project, only
   * rules for all projects.
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
}

const now = () => new Date().toISOString();

const cleanConditions = (conditions: string[]) => conditions.map((c) => c.trim()).filter((c) => c.length > 0);

/** What a version needs before it can be live. */
function requireComplete(content: RuleContent): void {
  if (!content.instruction.trim()) throw new RuleError("A rule needs an instruction.");
  if (cleanConditions(content.conditions).length === 0) throw new RuleError("A rule needs at least one condition.");
}

function requireCheckType(checkType: unknown): asserts checkType is CheckType {
  if (checkType !== "message" && checkType !== "reply") {
    throw new RuleError("A rule's check type is message or reply.");
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

/** What a scope needs before it can be live. */
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

export function createRulesService(db: Store): RulesService {
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

  function insertDraft(ruleId: number, content: Required<DraftContent>): void {
    const ids = content.scope.kind === "projects" ? projectIds(content.scope.projects) : [];
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO versions (rule_id, number, name, instruction, all_projects, created_at) VALUES (?, NULL, ?, ?, ?, ?)",
      )
      .run(ruleId, content.name, content.instruction, content.scope.kind === "all" ? 1 : 0, now());
    const addCondition = db.prepare("INSERT INTO conditions (version_id, position, text) VALUES (?, ?, ?)");
    cleanConditions(content.conditions).forEach((text, position) => addCondition.run(lastInsertRowid, position, text));
    const addProject = db.prepare("INSERT INTO version_projects (version_id, project_id) VALUES (?, ?)");
    for (const id of ids) addProject.run(lastInsertRowid, id);
  }

  function scopeOf(versionId: number): Scope {
    const { all_projects } = db.prepare("SELECT all_projects FROM versions WHERE id = ?").get(versionId) as {
      all_projects: number;
    };
    if (all_projects === 1) return { kind: "all" };
    const rows = db
      .prepare(
        `SELECT p.name FROM version_projects vp JOIN projects p ON p.id = vp.project_id
          WHERE vp.version_id = ? ORDER BY lower(p.name), p.name`,
      )
      .all(versionId) as { name: string }[];
    return { kind: "projects", projects: rows.map((row) => row.name) };
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

  function conditionsOf(versionId: number): string[] {
    return (
      db.prepare("SELECT text FROM conditions WHERE version_id = ? ORDER BY position").all(versionId) as {
        text: string;
      }[]
    ).map((row) => row.text);
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
      scope: scopeOf(row.id),
    };
  }

  function requireRule(ruleId: number): { name: string; check_type: CheckType; switched_off: number } {
    const row = db.prepare("SELECT name, check_type, switched_off FROM rules WHERE id = ?").get(ruleId) as
      | { name: string; check_type: CheckType; switched_off: number }
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
      if (value !== undefined && validSetting(key, value)) result[key] = value;
    }
    return result;
  }

  return {
    ...createAnalyticsQueries(db, requireRule),
    ...createFlags(db, requireRule),

    createRule(rule) {
      const name = cleanName(rule.name);
      requireCheckType(rule.checkType);
      requireComplete(rule);
      const scope = rule.scope ?? ALL_PROJECTS;
      requireScope(scope);
      requireCompleteScope(scope);
      return transaction(db, () => {
        requireFreeName(name);
        // A deleted rule's firings and scores stay, so a new rule never takes an
        // id they still name; otherwise SQLite reuses the highest free id.
        const { next } = db
          .prepare(
            `SELECT MAX(COALESCE((SELECT MAX(id) FROM rules), 0),
                        COALESCE((SELECT MAX(rule_id) FROM firings), 0),
                        COALESCE((SELECT MAX(rule_id) FROM scores), 0)) + 1 AS next`,
          )
          .get() as { next: number };
        db.prepare("INSERT INTO rules (id, name, check_type, created_at) VALUES (?, ?, ?, ?)").run(
          next,
          name,
          rule.checkType,
          now(),
        );
        const ruleId = Number(next);
        insertDraft(ruleId, { name, instruction: rule.instruction, conditions: rule.conditions, scope });
        return { ruleId };
      });
    },

    saveDraft(ruleId, content) {
      if (content.scope !== undefined) requireScope(content.scope);
      transaction(db, () => {
        const rule = requireRule(ruleId);
        const existing = draft(ruleId);
        const name = content.name === undefined ? (existing?.name ?? rule.name) : cleanName(content.name);
        const kept = existing ?? live(ruleId);
        const scope = content.scope ?? (kept ? scopeOf(kept.id) : ALL_PROJECTS);
        replaceDraft(ruleId, { name, instruction: content.instruction, conditions: content.conditions, scope });
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
          conditions: conditionsOf(source.id),
          scope: scopeOf(source.id),
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
      });
    },

    switchOff(ruleId) {
      setSwitchedOff(ruleId, true);
    },

    switchOn(ruleId) {
      setSwitchedOff(ruleId, false);
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
        requireCompleteScope(scopeOf(row.id));
        requireFreeName(row.name, ruleId);
        const versionNumber = (live(ruleId)?.number ?? 0) + 1;
        db.prepare("UPDATE versions SET number = ?, published_at = ? WHERE id = ?").run(versionNumber, now(), row.id);
        db.prepare("UPDATE rules SET name = ? WHERE id = ?").run(row.name, ruleId);
        return { versionNumber };
      });
    },

    liveRules(checkType, project) {
      const rows = db
        .prepare(
          `SELECT r.id AS ruleId, r.name AS name, v.id AS versionId, v.number AS versionNumber,
                  v.instruction AS instruction, c.id AS conditionId, c.text AS conditionText
             FROM rules r
             JOIN versions v ON v.rule_id = r.id
                            AND v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id)
             JOIN conditions c ON c.version_id = v.id
            WHERE r.check_type = ? AND r.switched_off = 0
              AND (v.all_projects = 1
                   OR EXISTS (SELECT 1 FROM version_projects vp JOIN projects p ON p.id = vp.project_id
                               WHERE vp.version_id = v.id AND p.name = ?))
            ORDER BY r.id, c.position`,
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
      if (filter.checkType) {
        where.push("check_type = ?");
        params.push(filter.checkType);
      }
      const states = filter.state === undefined ? [] : [filter.state].flat();
      if (states.length) {
        where.push(`state IN (${states.map(() => "?").join(", ")})`);
        params.push(...states);
      }
      if (filter.hasDraft !== undefined) {
        where.push("has_draft = ?");
        params.push(filter.hasDraft ? 1 : 0);
      }
      const search = filter.search?.trim();
      if (search) {
        // The live version and the draft count; older versions do not.
        where.push(`EXISTS (
          SELECT 1 FROM versions v
           WHERE v.rule_id = r.id
             AND (v.number IS NULL OR v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id))
             AND (instr(lower(v.name), ?) OR instr(lower(v.instruction), ?)
                  OR EXISTS (SELECT 1 FROM conditions c WHERE c.version_id = v.id AND instr(lower(c.text), ?))))`);
        const needle = search.toLowerCase();
        params.push(needle, needle, needle);
      }
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT r.id, r.name, r.check_type, r.switched_off,
                    CASE WHEN NOT EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NOT NULL)
                         THEN 'draft' WHEN r.switched_off THEN 'off' ELSE 'live' END AS state,
                    EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NULL) AS has_draft
               FROM rules r) r
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY lower(name), id`,
        )
        .all(...params) as {
        id: number;
        name: string;
        check_type: CheckType;
        switched_off: number;
        state: RuleState;
        has_draft: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        checkType: row.check_type,
        state: row.state,
        on: row.switched_off === 0,
        hasDraft: row.has_draft === 1,
      }));
    },

    getRule(ruleId) {
      const rule = requireRule(ruleId);
      const versions = published(ruleId).map(publishedView);
      const draftRow = draft(ruleId);
      const on = rule.switched_off === 0;
      return {
        id: ruleId,
        name: rule.name,
        checkType: rule.check_type,
        state: versions.length === 0 ? "draft" : on ? "live" : "off",
        on,
        hasDraft: draftRow !== undefined,
        live: versions[0] ?? null,
        versions,
        draft: draftRow
          ? {
              savedAt: draftRow.created_at,
              name: draftRow.name,
              instruction: draftRow.instruction,
              conditions: conditionsOf(draftRow.id),
              scope: scopeOf(draftRow.id),
            }
          : null,
      };
    },

    projects() {
      const rows = db
        .prepare("SELECT name, first_seen_at FROM projects ORDER BY lower(name), name")
        .all() as { name: string; first_seen_at: string }[];
      return rows.map((row) => ({ name: row.name, firstSeenAt: row.first_seen_at }));
    },

    settings: readSettings,

    updateSettings(changes) {
      const entries = SETTINGS.filter((key) => changes[key] !== undefined).map((key) => [key, changes[key]!] as const);
      for (const [key, value] of entries) {
        if (!validSetting(key, value)) throw new RuleError(SETTING_RANGES[key]);
      }
      transaction(db, () => {
        const save = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        );
        for (const [key, value] of entries) save.run(SETTING_KEYS[key], value);
      });
      return readSettings();
    },
  };
}
