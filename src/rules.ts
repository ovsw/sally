import { type Store, transaction } from "./store.ts";

export type CheckType = "message" | "reply";

export interface RuleContent {
  instruction: string;
  conditions: string[];
}

export interface NewRule extends RuleContent {
  name: string;
  checkType: CheckType;
}

/**
 * What a draft holds. Without a name or a check type, the draft keeps the one
 * it has.
 */
export interface DraftContent extends RuleContent {
  name?: string;
  checkType?: CheckType;
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

/** A rule is live once published; until then it has only its draft. */
export type RuleState = "live" | "draft";

/**
 * One row of the rules list. `name` and `checkType` are the ones in force (the
 * live version's, if any).
 */
export interface RuleSummary {
  id: number;
  name: string;
  checkType: CheckType;
  state: RuleState;
  hasDraft: boolean;
}

export interface VersionView {
  name: string;
  checkType: CheckType;
  instruction: string;
  conditions: string[];
}

export interface PublishedVersionView extends VersionView {
  number: number;
  publishedAt: string;
}

export interface DraftView extends VersionView {
  savedAt: string;
}

/** A rule with its live version and its draft side by side. */
export interface RuleDetail extends RuleSummary {
  live: PublishedVersionView | null;
  draft: DraftView | null;
}

export interface RuleFilter {
  /** Matches the name, instruction or conditions of the live version or the draft, ignoring case. */
  search?: string;
  checkType?: CheckType;
  state?: RuleState;
  hasDraft?: boolean;
}

export class RuleError extends Error {}

export class RuleNotFoundError extends RuleError {}

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

export interface RulesService {
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
  /** The live version of every rule of this check type, read fresh from the database. */
  liveRules(checkType: CheckType): LiveRule[];
  /** Every rule matching the filter, by name. */
  listRules(filter?: RuleFilter): RuleSummary[];
  /** One rule with its live version and its draft. */
  getRule(ruleId: number): RuleDetail;
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

function cleanName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) throw new RuleError("A rule needs a name.");
  return cleaned;
}

interface VersionRow {
  id: number;
  number: number | null;
  name: string;
  check_type: CheckType;
  instruction: string;
  created_at: string;
  published_at: string | null;
}

const VERSION_COLUMNS = "id, number, name, check_type, instruction, created_at, published_at";

export function createRulesService(db: Store): RulesService {
  function insertDraft(ruleId: number, content: Required<DraftContent>): void {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO versions (rule_id, number, name, check_type, instruction, created_at) VALUES (?, NULL, ?, ?, ?, ?)",
      )
      .run(ruleId, content.name, content.checkType, content.instruction, now());
    const addCondition = db.prepare("INSERT INTO conditions (version_id, position, text) VALUES (?, ?, ?)");
    cleanConditions(content.conditions).forEach((text, position) => addCondition.run(lastInsertRowid, position, text));
  }

  function draft(ruleId: number): VersionRow | undefined {
    return db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM versions WHERE rule_id = ? AND number IS NULL`)
      .get(ruleId) as VersionRow | undefined;
  }

  function live(ruleId: number): VersionRow | undefined {
    return db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM versions
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

  function requireRule(ruleId: number): { name: string; check_type: CheckType } {
    const row = db.prepare("SELECT name, check_type FROM rules WHERE id = ?").get(ruleId) as
      | { name: string; check_type: CheckType }
      | undefined;
    if (!row) throw new RuleNotFoundError(`No rule with id ${ruleId}.`);
    return row;
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
    createRule(rule) {
      const name = cleanName(rule.name);
      requireCheckType(rule.checkType);
      requireComplete(rule);
      return transaction(db, () => {
        requireFreeName(name);
        const { lastInsertRowid } = db
          .prepare("INSERT INTO rules (name, check_type, created_at) VALUES (?, ?, ?)")
          .run(name, rule.checkType, now());
        const ruleId = Number(lastInsertRowid);
        insertDraft(ruleId, {
          name,
          checkType: rule.checkType,
          instruction: rule.instruction,
          conditions: rule.conditions,
        });
        return { ruleId };
      });
    },

    saveDraft(ruleId, content) {
      if (content.checkType !== undefined) requireCheckType(content.checkType);
      transaction(db, () => {
        const rule = requireRule(ruleId);
        const existing = draft(ruleId);
        const name = content.name === undefined ? (existing?.name ?? rule.name) : cleanName(content.name);
        const checkType = content.checkType ?? existing?.check_type ?? rule.check_type;
        requireFreeName(name, ruleId);
        if (existing) db.prepare("DELETE FROM versions WHERE id = ?").run(existing.id);
        insertDraft(ruleId, { name, checkType, instruction: content.instruction, conditions: content.conditions });
        // A rule never published goes by its draft's name and check type.
        if (!live(ruleId)) {
          db.prepare("UPDATE rules SET name = ?, check_type = ? WHERE id = ?").run(name, checkType, ruleId);
        }
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
        db.prepare("UPDATE rules SET name = ?, check_type = ? WHERE id = ?").run(row.name, row.check_type, ruleId);
        return { versionNumber };
      });
    },

    liveRules(checkType) {
      const rows = db
        .prepare(
          `SELECT r.id AS ruleId, r.name AS name, v.id AS versionId, v.number AS versionNumber,
                  v.instruction AS instruction, c.id AS conditionId, c.text AS conditionText
             FROM rules r
             JOIN versions v ON v.rule_id = r.id
                            AND v.number = (SELECT MAX(number) FROM versions WHERE rule_id = r.id)
             JOIN conditions c ON c.version_id = v.id
            WHERE r.check_type = ?
            ORDER BY r.id, c.position`,
        )
        .all(checkType) as {
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
      if (filter.state) {
        where.push("state = ?");
        params.push(filter.state);
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
             SELECT r.id, r.name, r.check_type,
                    CASE WHEN EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NOT NULL)
                         THEN 'live' ELSE 'draft' END AS state,
                    EXISTS (SELECT 1 FROM versions WHERE rule_id = r.id AND number IS NULL) AS has_draft
               FROM rules r) r
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY lower(name), id`,
        )
        .all(...params) as { id: number; name: string; check_type: CheckType; state: RuleState; has_draft: number }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        checkType: row.check_type,
        state: row.state,
        hasDraft: row.has_draft === 1,
      }));
    },

    getRule(ruleId) {
      const rule = requireRule(ruleId);
      const liveRow = live(ruleId);
      const draftRow = draft(ruleId);
      return {
        id: ruleId,
        name: rule.name,
        checkType: rule.check_type,
        state: liveRow ? "live" : "draft",
        hasDraft: draftRow !== undefined,
        live: liveRow
          ? {
              number: liveRow.number!,
              publishedAt: liveRow.published_at!,
              name: liveRow.name,
              checkType: liveRow.check_type,
              instruction: liveRow.instruction,
              conditions: conditionsOf(liveRow.id),
            }
          : null,
        draft: draftRow
          ? {
              savedAt: draftRow.created_at,
              name: draftRow.name,
              checkType: draftRow.check_type,
              instruction: draftRow.instruction,
              conditions: conditionsOf(draftRow.id),
            }
          : null,
      };
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
