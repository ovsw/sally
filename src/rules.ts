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

export class RuleError extends Error {}

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
  /** Replaces the rule's draft with this content, creating the draft if there is none. */
  saveDraft(ruleId: number, content: RuleContent): void;
  /** Turns the draft into a new live version and returns its number. */
  publish(ruleId: number): { versionNumber: number };
  /** The live version of every rule of this check type, read fresh from the database. */
  liveRules(checkType: CheckType): LiveRule[];
  /** The stored settings, each falling back to its default. */
  settings(): Settings;
  /** Stores the given settings and returns them all. Refuses a value out of range. */
  updateSettings(changes: Partial<Settings>): Settings;
}

const now = () => new Date().toISOString();

function clean(content: RuleContent): RuleContent {
  const conditions = content.conditions.map((c) => c.trim()).filter((c) => c.length > 0);
  if (!content.instruction.trim()) throw new RuleError("A rule needs an instruction.");
  if (conditions.length === 0) throw new RuleError("A rule needs at least one condition.");
  return { instruction: content.instruction, conditions };
}

export function createRulesService(db: Store): RulesService {
  function insertDraft(ruleId: number, content: RuleContent): void {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO versions (rule_id, number, instruction, created_at) VALUES (?, NULL, ?, ?)")
      .run(ruleId, content.instruction, now());
    const addCondition = db.prepare("INSERT INTO conditions (version_id, position, text) VALUES (?, ?, ?)");
    content.conditions.forEach((text, position) => addCondition.run(lastInsertRowid, position, text));
  }

  function draftId(ruleId: number): number | undefined {
    const row = db.prepare("SELECT id FROM versions WHERE rule_id = ? AND number IS NULL").get(ruleId) as
      | { id: number }
      | undefined;
    return row?.id;
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

  function requireRule(ruleId: number): void {
    if (!db.prepare("SELECT 1 FROM rules WHERE id = ?").get(ruleId)) {
      throw new RuleError(`No rule with id ${ruleId}.`);
    }
  }

  return {
    createRule(rule) {
      const name = rule.name.trim();
      if (!name) throw new RuleError("A rule needs a name.");
      if (rule.checkType !== "message" && rule.checkType !== "reply") {
        throw new RuleError("A rule's check type is message or reply.");
      }
      const content = clean(rule);
      return transaction(db, () => {
        if (db.prepare("SELECT 1 FROM rules WHERE name = ?").get(name)) {
          throw new RuleError(`A rule named "${name}" already exists.`);
        }
        const { lastInsertRowid } = db
          .prepare("INSERT INTO rules (name, check_type, created_at) VALUES (?, ?, ?)")
          .run(name, rule.checkType, now());
        const ruleId = Number(lastInsertRowid);
        insertDraft(ruleId, content);
        return { ruleId };
      });
    },

    saveDraft(ruleId, content) {
      const cleaned = clean(content);
      transaction(db, () => {
        requireRule(ruleId);
        const existing = draftId(ruleId);
        if (existing !== undefined) db.prepare("DELETE FROM versions WHERE id = ?").run(existing);
        insertDraft(ruleId, cleaned);
      });
    },

    publish(ruleId) {
      return transaction(db, () => {
        requireRule(ruleId);
        const draft = draftId(ruleId);
        if (draft === undefined) throw new RuleError("This rule has no draft to publish.");
        const { last } = db
          .prepare("SELECT COALESCE(MAX(number), 0) AS last FROM versions WHERE rule_id = ?")
          .get(ruleId) as { last: number };
        const versionNumber = last + 1;
        db.prepare("UPDATE versions SET number = ?, published_at = ? WHERE id = ?").run(versionNumber, now(), draft);
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
