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

/** What a draft holds. Without a name, the draft keeps the name it has. */
export interface DraftContent extends RuleContent {
  name?: string;
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

/** One row of the rules list. `name` is the name in force (the live one, if any). */
export interface RuleSummary {
  id: number;
  name: string;
  checkType: CheckType;
  state: RuleState;
  hasDraft: boolean;
}

export interface VersionView {
  name: string;
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
  instruction: string;
  created_at: string;
  published_at: string | null;
}

export function createRulesService(db: Store): RulesService {
  function insertDraft(ruleId: number, content: Required<DraftContent>): void {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO versions (rule_id, number, name, instruction, created_at) VALUES (?, NULL, ?, ?, ?)")
      .run(ruleId, content.name, content.instruction, now());
    const addCondition = db.prepare("INSERT INTO conditions (version_id, position, text) VALUES (?, ?, ?)");
    cleanConditions(content.conditions).forEach((text, position) => addCondition.run(lastInsertRowid, position, text));
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
        insertDraft(ruleId, { name, instruction: rule.instruction, conditions: rule.conditions });
        return { ruleId };
      });
    },

    saveDraft(ruleId, content) {
      transaction(db, () => {
        const rule = requireRule(ruleId);
        const existing = draft(ruleId);
        const name = content.name === undefined ? (existing?.name ?? rule.name) : cleanName(content.name);
        requireFreeName(name, ruleId);
        if (existing) db.prepare("DELETE FROM versions WHERE id = ?").run(existing.id);
        insertDraft(ruleId, { name, instruction: content.instruction, conditions: content.conditions });
        // A rule never published goes by its draft's name.
        if (!live(ruleId)) db.prepare("UPDATE rules SET name = ? WHERE id = ?").run(name, ruleId);
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
              instruction: liveRow.instruction,
              conditions: conditionsOf(liveRow.id),
            }
          : null,
        draft: draftRow
          ? {
              savedAt: draftRow.created_at,
              name: draftRow.name,
              instruction: draftRow.instruction,
              conditions: conditionsOf(draftRow.id),
            }
          : null,
      };
    },
  };
}
