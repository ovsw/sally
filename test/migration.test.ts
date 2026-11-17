import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
import { OLD_SCHEMA, OLD_SCHEMA_VERSION } from "./support/old-schema.ts";
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
