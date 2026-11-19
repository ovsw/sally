import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
import { BEFORE_SWITCHES_SCHEMA, BEFORE_SWITCHES_SCHEMA_VERSION } from "./support/before-switches-schema.ts";
import { OLD_SCHEMA, OLD_SCHEMA_VERSION } from "./support/old-schema.ts";
import { PREVIOUS_SCHEMA, PREVIOUS_SCHEMA_VERSION } from "./support/previous-schema.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const AT = "2026-01-01T00:00:00.000Z";

/**
 * Writes a database in the old shape, holding one live rule with three
 * flagged matches (one flag of each old kind) and their saved cases.
 */
function writeOldDatabase(): void {
  const path = databasePath(sandbox.env);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(OLD_SCHEMA);
    db.exec(`
      INSERT INTO rules (id, name, check_type, created_at) VALUES (1, 'Old rule', 'message', '${AT}');
      INSERT INTO versions (id, rule_id, number, instruction, created_at, published_at, name)
        VALUES (1, 1, 1, 'Do the old thing.', '${AT}', '${AT}', 'Old rule');
      INSERT INTO conditions (id, version_id, position, text) VALUES (1, 1, 0, 'Condition A.');
    `);
    const check = db.prepare(
      `INSERT INTO checks (id, created_at, session_id, check_type, text, duration_ms, cutoff, outcome, cap)
       VALUES (?, '${AT}', 'session-1', 'message', ?, 5, 0.5, 'attached', 3)`,
    );
    const flagged: [text: string, verdict: string, raisedBy: string, expected: string][] = [
      ["first message", "wrong", "claude", "should_not_fire"],
      ["second message", "correct", "user", "should_fire"],
      ["third message", "wrong", "automatic", "should_not_fire"],
    ];
    flagged.forEach(([text, verdict, raisedBy, expected], index) => {
      const id = index + 1;
      check.run(id, text);
      db.prepare("INSERT INTO scores (check_id, rule_id, version_id, condition_id, score) VALUES (?, 1, 1, 1, 0.8)").run(id);
      db.prepare(
        "INSERT INTO firings (id, check_id, rule_id, version_id, condition_id, score, dropped) VALUES (?, ?, 1, 1, 1, 0.8, 0)",
      ).run(id, id);
      db.prepare("INSERT INTO flags (id, firing_id, verdict, raised_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        id,
        verdict,
        raisedBy,
        AT,
      );
      db.prepare(
        "INSERT INTO saved_cases (rule_id, check_type, text, expected, flag_id, created_at) VALUES (1, 'message', ?, ?, ?, ?)",
      ).run(text, expected, id, AT);
    });
    db.exec(`PRAGMA user_version = ${OLD_SCHEMA_VERSION}`);
  } finally {
    db.close();
  }
}

const schema = (box: Sandbox) =>
  box
    .query<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    .map((row) => [row.name, row.sql]);

describe("an old database", () => {
  it("keeps its matches, flags and saved cases under the new words", async () => {
    writeOldDatabase();

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(1));
    expect(analytics.matches).toBe(3);
    expect(analytics.recentMatches.map((m) => [m.text, m.flag?.verdict, m.flag?.raisedBy]).reverse()).toEqual([
      ["first message", "wrong", "claude"],
      ["second message", "right", "user"],
      ["third message", "wrong", "claude"],
    ]);

    const cases = sandbox.withRules((rules) => rules.savedCases(1));
    expect(cases.map((c) => [c.text, c.expected, c.source?.verdict]).reverse()).toEqual([
      ["first message", "should_not_match", "wrong"],
      ["second message", "should_match", "right"],
      ["third message", "should_not_match", "wrong"],
    ]);
  });

  it("goes on working: a new match is recorded and can be flagged right", async () => {
    writeOldDatabase();

    await runMessageHook(hookInput("fourth message"), {
      env: sandbox.env,
      matcher: standInMatcher({ "Condition A.": 0.9 }),
    });
    const [latest] = sandbox.withRules((rules) => rules.ruleAnalytics(1)).recentMatches;
    expect(latest).toMatchObject({ text: "fourth message", flag: null });

    sandbox.withRules((rules) => rules.flagMatch(latest!.matchId, "right", "user"));
    const cases = sandbox.withRules((rules) => rules.savedCases(1));
    expect(cases).toHaveLength(4);
    expect(cases[0]).toMatchObject({ text: "fourth message", expected: "should_match" });

    // The user's flag replaces Claude's, and takes the old saved case with it.
    const [, , , first] = sandbox.withRules((rules) => rules.ruleAnalytics(1)).recentMatches;
    sandbox.withRules((rules) => rules.flagMatch(first!.matchId, "right", "user"));
    expect(
      sandbox
        .withRules((rules) => rules.savedCases(1))
        .filter((c) => c.text === "first message")
        .map((c) => c.expected),
    ).toEqual(["should_match"]);
  });

  it("stops the turn on a failed check from then on, and keeps the settings it had", async () => {
    writeOldDatabase();
    const old = new DatabaseSync(databasePath(sandbox.env));
    old.exec("INSERT INTO settings (key, value) VALUES ('time_limit_ms', 4000)");
    old.close();

    // The old rule's check fails on both tries, so the message is blocked.
    const output = await runMessageHook(hookInput("fifth message"), {
      env: sandbox.env,
      matcher: standInMatcher({}, { answer: () => Promise.reject(new Error("fetch failed")) }),
    });
    expect(JSON.parse(output).decision).toBe("block");

    expect(sandbox.withRules((rules) => rules.settings())).toMatchObject({ stopOnFailure: true, timeLimitMs: 4000 });
    expect(sandbox.query("SELECT key, value FROM settings ORDER BY key")).toEqual([
      { key: "stop_on_failure", value: 1 },
      { key: "time_limit_ms", value: 4000 },
    ]);
    expect(sandbox.query("PRAGMA user_version")).toEqual([{ user_version: 15 }]);
  });

  it("can have an attention reason cleared", () => {
    writeOldDatabase();

    // The old rule matched on all three of its checks.
    sandbox.withRules((rules) => rules.clearAttentionReason(1, "matches_often"));

    expect(sandbox.withRules((rules) => rules.attention()).flatMap((e) => e.reasons.map((r) => r.kind))).toEqual([
      "wrong_matches",
    ]);
    expect(sandbox.query("SELECT version_id, kind FROM cleared_reasons")).toEqual([
      { version_id: 1, kind: "matches_often" },
    ]);
  });

  it("ends in the same shape as a new database", () => {
    writeOldDatabase();
    sandbox.withRules(() => undefined);

    const fresh = createSandbox();
    try {
      fresh.withRules(() => undefined);
      expect(schema(sandbox)).toEqual(schema(fresh));
    } finally {
      fresh.cleanup();
    }
  });
});

/** Writes a database in the shape before the import, holding one live rule. */
function writePreviousDatabase(): void {
  const path = databasePath(sandbox.env);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(PREVIOUS_SCHEMA);
    db.exec(`
      INSERT INTO rules (id, name, check_type, created_at) VALUES (1, 'Kept rule', 'message', '${AT}');
      INSERT INTO versions (id, rule_id, number, name, check_type, instruction, all_projects, created_at, published_at)
        VALUES (1, 1, 1, 'Kept rule', 'message', 'Do the kept thing.', 1, '${AT}', '${AT}');
      INSERT INTO conditions (id, version_id, position, text) VALUES (1, 1, 0, 'Condition K.');
      PRAGMA user_version = ${PREVIOUS_SCHEMA_VERSION};
    `);
  } finally {
    db.close();
  }
}

describe("a database from before the import", () => {
  it("upgrades, keeps its rules, and takes an import", () => {
    writePreviousDatabase();

    expect(sandbox.withRules((rules) => rules.liveRules("message"))).toMatchObject([
      { ruleId: 1, name: "Kept rule", instruction: "Do the kept thing.", conditions: [{ text: "Condition K." }] },
    ]);

    const file = join(sandbox.root, ".claude", "CLAUDE.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "Always answer briefly.\n");
    const detail = sandbox.withImports((imports) => {
      const { id } = imports.startImport(file);
      return imports.addPassages(id, [
        { text: "Always answer briefly.", verdict: "always_rule", reason: "It applies on every turn." },
      ]);
    });
    expect(detail.passages).toHaveLength(1);
  });

  it("judges replies at the cutoff it had, when its cutoff was changed", () => {
    writePreviousDatabase();
    const previous = new DatabaseSync(databasePath(sandbox.env));
    previous.exec("INSERT INTO settings (key, value) VALUES ('cutoff', 0.85)");
    previous.close();

    expect(sandbox.withRules((rules) => rules.settings())).toMatchObject({ cutoff: 0.85, replyCutoff: 0.85 });
  });

  it("takes the default reply cutoff when its cutoff was never changed", () => {
    writePreviousDatabase();

    expect(sandbox.withRules((rules) => rules.settings())).toMatchObject({ cutoff: 0.6, replyCutoff: 0.6 });
  });

  it("ends in the same shape as a new database", () => {
    writePreviousDatabase();
    sandbox.withRules(() => undefined);

    const fresh = createSandbox();
    try {
      fresh.withRules(() => undefined);
      expect(schema(sandbox)).toEqual(schema(fresh));
    } finally {
      fresh.cleanup();
    }
  });
});

/**
 * Writes a database from before conditions had switches: a message rule with
 * two published versions and a draft, a reply rule, and a rule never
 * published, with scores, matches, a flag and a saved case.
 */
function writeBeforeSwitchesDatabase(): void {
  const path = databasePath(sandbox.env);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(BEFORE_SWITCHES_SCHEMA);
    db.exec(`
      INSERT INTO rules (id, name, check_type, created_at) VALUES
        (1, 'Message rule', 'message', '${AT}'),
        (2, 'Reply rule', 'reply', '${AT}'),
        (3, 'Draft rule', 'message', '${AT}');
      INSERT INTO versions (id, rule_id, number, name, check_type, instruction, all_projects, created_at, published_at) VALUES
        (1, 1, 1, 'Message rule', 'message', 'Do X.', 1, '${AT}', '${AT}'),
        (2, 1, 2, 'Message rule', 'message', 'Do X better.', 1, '${AT}', '${AT}'),
        (3, 1, NULL, 'Message rule', 'message', 'Do X best.', 1, '${AT}', NULL),
        (4, 2, 1, 'Reply rule', 'reply', 'Be brief.', 1, '${AT}', '${AT}'),
        (5, 3, NULL, 'Draft rule', 'message', 'Do Z.', 1, '${AT}', NULL);
      INSERT INTO conditions (id, version_id, position, text) VALUES
        (1, 1, 0, 'Asks for X.'), (2, 1, 1, 'Mentions Y.'),
        (3, 2, 0, 'Asks for X.'), (4, 2, 1, 'Mentions Y, reworded.'),
        (5, 3, 0, 'Asks for X.'), (6, 3, 1, 'New in draft.'),
        (7, 4, 0, 'The reply is long.'),
        (8, 5, 0, 'Draft condition.');
      INSERT INTO checks (id, created_at, session_id, check_type, text, duration_ms, cutoff, outcome) VALUES
        (1, '${AT}', 'session-1', 'message', 'first message', 5, 0.6, 'attached'),
        (2, '${AT}', 'session-1', 'message', 'second message', 5, 0.6, 'attached'),
        (3, '${AT}', 'session-1', 'reply', 'a long reply', 5, 0.6, 'sent_back');
      INSERT INTO scores (check_id, rule_id, version_id, condition_id, score) VALUES
        (1, 1, 1, 1, 0.9), (1, 1, 1, 2, 0.1),
        (2, 1, 2, 3, 0.8), (2, 1, 2, 4, 0.2),
        (3, 2, 4, 7, 0.7);
      INSERT INTO matches (id, check_id, rule_id, version_id, condition_id, score) VALUES
        (1, 1, 1, 1, 1, 0.9), (2, 2, 1, 2, 3, 0.8), (3, 3, 2, 4, 7, 0.7);
      INSERT INTO flags (id, match_id, verdict, raised_by, created_at) VALUES (1, 1, 'wrong', 'user', '${AT}');
      INSERT INTO saved_cases (rule_id, check_type, text, expected, flag_id, created_at)
        VALUES (1, 'message', 'first message', 'should_not_match', 1, '${AT}');
      PRAGMA user_version = ${BEFORE_SWITCHES_SCHEMA_VERSION};
    `);
  } finally {
    db.close();
  }
}

describe("a database from before conditions had switches", () => {
  it("matches every rule exactly as before, each condition on for its rule's check type", () => {
    writeBeforeSwitchesDatabase();

    sandbox.withRules((rules) => {
      expect(rules.liveRules("message")).toMatchObject([
        {
          ruleId: 1,
          versionNumber: 2,
          instruction: "Do X better.",
          conditions: [{ text: "Asks for X." }, { text: "Mentions Y, reworded." }],
        },
      ]);
      expect(rules.liveRules("reply")).toMatchObject([{ ruleId: 2, conditions: [{ text: "The reply is long." }] }]);
      // No rules are merged.
      expect(rules.listRules().map((r) => [r.name, r.checkTypes, r.published])).toEqual([
        ["Draft rule", ["message"], false],
        ["Message rule", ["message"], true],
        ["Reply rule", ["reply"], true],
      ]);
      expect(rules.getRule(2).live!.conditions).toEqual([
        { id: expect.any(Number), text: "The reply is long.", message: false, reply: true },
      ]);
      expect(rules.getRule(3).draft!.conditions).toEqual([
        { id: expect.any(Number), text: "Draft condition.", message: true, reply: false },
      ]);
    });
  });

  it("makes the same wording across a rule's versions one condition, kept by its draft", () => {
    writeBeforeSwitchesDatabase();

    const rule = sandbox.withRules((rules) => rules.getRule(1));
    const [v2, v1] = rule.versions;
    const asks = v1!.conditions[0]!;
    expect(v2!.conditions[0]!.id).toBe(asks.id);
    expect(rule.draft!.conditions[0]!.id).toBe(asks.id);
    expect(v1!.conditions.map((c) => c.text)).toEqual(["Asks for X.", "Mentions Y."]);
    expect(new Set([...v1!.conditions, ...v2!.conditions, ...rule.draft!.conditions].map((c) => c.id)).size).toBe(4);
    expect(rule.draft!.conditions.map((c) => [c.text, c.message, c.reply])).toEqual([
      ["Asks for X.", true, false],
      ["New in draft.", true, false],
    ]);
  });

  it("keeps its scores, matches, flags and saved cases pointing at the right rule and condition", () => {
    writeBeforeSwitchesDatabase();

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(1));
    expect(analytics.recentMatches.map((m) => [m.text, m.versionNumber, m.condition, m.flag?.verdict ?? null])).toEqual([
      ["second message", 2, "Asks for X.", null],
      ["first message", 1, "Asks for X.", "wrong"],
    ]);
    expect(analytics.versions).toMatchObject([
      { number: 2, checks: 1, matches: 1, wrongMatches: 0 },
      { number: 1, checks: 1, matches: 1, wrongMatches: 1 },
    ]);
    expect(sandbox.withRules((rules) => rules.ruleAnalytics(2)).recentMatches).toMatchObject([
      { text: "a long reply", condition: "The reply is long." },
    ]);
    expect(sandbox.withRules((rules) => rules.savedCases(1))).toMatchObject([
      { text: "first message", expected: "should_not_match", source: { verdict: "wrong", checkId: 1 } },
    ]);

    const asks = sandbox.withRules((rules) => rules.getRule(1).versions[1]!.conditions[0]!.id);
    const scores = sandbox.query<{ check_id: number; condition_id: number; text: string }>(
      `SELECT s.check_id, s.condition_id, vc.text FROM scores s
         JOIN version_conditions vc ON vc.version_id = s.version_id AND vc.condition_id = s.condition_id
        ORDER BY s.check_id, vc.position`,
    );
    expect(scores.map((s) => [s.check_id, s.text])).toEqual([
      [1, "Asks for X."],
      [1, "Mentions Y."],
      [2, "Asks for X."],
      [2, "Mentions Y, reworded."],
      [3, "The reply is long."],
    ]);
    expect(scores.filter((s) => s.text === "Asks for X.").map((s) => s.condition_id)).toEqual([asks, asks]);
    expect(sandbox.query("SELECT check_id, condition_id FROM matches WHERE rule_id = 1 ORDER BY check_id")).toEqual([
      { check_id: 1, condition_id: asks },
      { check_id: 2, condition_id: asks },
    ]);
  });

  it("goes on matching: a new check scores the same condition", async () => {
    writeBeforeSwitchesDatabase();

    const output = await runMessageHook(hookInput("third message"), {
      env: sandbox.env,
      matcher: standInMatcher({ "Asks for X.": 0.9 }),
    });
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain("Do X better.");
    const [latest] = sandbox.withRules((rules) => rules.ruleAnalytics(1)).recentMatches;
    expect(latest).toMatchObject({ text: "third message", versionNumber: 2, condition: "Asks for X." });
    // Publishing the old draft keeps the lasting condition and starts the new one.
    sandbox.withRules((rules) => {
      rules.publish(1);
      expect(rules.liveRules("message")[0]!.conditions.map((c) => c.text)).toEqual(["Asks for X.", "New in draft."]);
    });
  });

  it("ends in the same shape as a new database", () => {
    writeBeforeSwitchesDatabase();
    sandbox.withRules(() => undefined);

    const fresh = createSandbox();
    try {
      fresh.withRules(() => undefined);
      expect(schema(sandbox)).toEqual(schema(fresh));
    } finally {
      fresh.cleanup();
    }
  });
});
