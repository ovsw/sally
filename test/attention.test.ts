import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import type { AttentionKind } from "../src/attention.ts";
import { conditionsFor, RuleError, RuleNotFoundError, type Settings } from "../src/rules.ts";
import { gitRepo } from "./support/git.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
let repo: string;
beforeEach(() => {
  sandbox = createSandbox();
  repo = gitRepo(join(sandbox.root, "repo"), { origin: "git@github.com:acme/widgets.git" });
});
afterEach(() => sandbox.cleanup());

/** Sends one message, scoring each condition by its text. */
const message = (scores: Record<string, number>, prompt = "A message to check") =>
  runMessageHook(hookInput(prompt, { cwd: repo }), { env: sandbox.env, matcher: standInMatcher(scores) });

const reply = (scores: Record<string, number>) =>
  runReplyHook(
    JSON.stringify({
      session_id: "session-1",
      transcript_path: join(sandbox.root, "missing.jsonl"),
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "A reply to check.",
    }),
    { env: sandbox.env, matcher: standInMatcher(scores) },
  );

const thresholds = (changes: Partial<Settings>) => sandbox.withRules((rules) => rules.updateSettings(changes));
const attention = () => sandbox.withRules((rules) => rules.attention());

/**
 * Flags a match as the flags feature records it. Until that feature has
 * landed the table may not exist yet, so it is created here when missing.
 */
function flag(matchId: number, verdict: "wrong" | "right"): void {
  const db = new DatabaseSync(databasePath(sandbox.env));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS flags (
      id          INTEGER PRIMARY KEY,
      match_id    INTEGER NOT NULL UNIQUE REFERENCES matches (id) ON DELETE CASCADE,
      verdict     TEXT NOT NULL CHECK (verdict IN ('wrong', 'right')),
      raised_by   TEXT NOT NULL CHECK (raised_by IN ('claude', 'user')),
      created_at  TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO flags (match_id, verdict, raised_by, created_at) VALUES (?, ?, 'user', ?)").run(
      matchId,
      verdict,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

const matchesOf = (ruleId: number) =>
  sandbox.query<{ id: number }>("SELECT id FROM matches WHERE rule_id = ? ORDER BY id", ruleId).map((row) => row.id);

describe("needs attention", () => {
  it("lists nothing while every rule behaves", async () => {
    sandbox.liveRule({ name: "Steady", conditions: ["Condition A."] });
    await message({ "Condition A.": 0.9 });
    for (let i = 0; i < 4; i++) await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([]);
  });

  it("lists a rule that matches on a large share of its recent checks, and says why", async () => {
    thresholds({ recentChecks: 4, busyShare: 0.5 });
    const eager = sandbox.liveRule({ name: "Eager", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Calm", conditions: ["Condition B."] });
    // Eager matches on checks 1, 3 and 4; only the latest four count, so 2 of 4.
    await message({ "Condition A.": 0.9, "Condition B.": 0.9 });
    await message({ "Condition A.": 0.1 });
    await message({ "Condition A.": 0.9 });
    await message({ "Condition A.": 0.9 });
    await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([
      {
        ruleId: eager,
        name: "Eager",
        checkTypes: ["message"],
        versionNumber: 1,
        reasons: [
          {
            kind: "matches_often",
            matches: 2,
            checks: 4,
            share: 0.5,
            threshold: 0.5,
            summary: "Matched on 2 of its last 4 checks (50%); the threshold is 50%.",
          },
        ],
      },
    ]);
  });

  it("does not list a rule match on less than the share", async () => {
    thresholds({ recentChecks: 4, busyShare: 0.5 });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message({ "Condition A.": 0.9 });
    for (let i = 0; i < 3; i++) await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([]);
  });

  it("lists a rule whose matches score close above the cutoff, judged against the cutoff in force", async () => {
    thresholds({ busyShare: 1, closeMargin: 0.05 });
    const weak = sandbox.liveRule({ name: "Weak", conditions: ["Weak condition."] });
    sandbox.liveRule({ name: "Strong", conditions: ["Strong condition."] });
    await message({ "Weak condition.": 0.65, "Strong condition.": 0.66 }); // exactly the margin; just past it
    await message({ "Weak condition.": 0.9 });
    // Under a higher cutoff, 0.82 is close above it, though far above today's.
    thresholds({ cutoff: 0.8 });
    await message({ "Weak condition.": 0.82, "Strong condition.": 0.86 });
    thresholds({ cutoff: 0.6 });
    await message({});

    expect(attention()).toMatchObject([
      {
        ruleId: weak,
        name: "Weak",
        reasons: [
          {
            kind: "weak_matches",
            weakMatches: 2,
            matches: 3,
            margin: 0.05,
            summary: "2 of its 3 recent matches scored no more than 0.05 above the cutoff.",
          },
        ],
      },
    ]);
  });

  it("lists a rule with no matches over a long stretch of checks, once it has had that many", async () => {
    thresholds({ quietChecks: 3 });
    const dead = sandbox.liveRule({ name: "Dead", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Alive", conditions: ["Condition B."] });
    await message({});
    await message({ "Condition B.": 0.9 });
    sandbox.liveRule({ name: "Young", conditions: ["Condition C."] });
    await message({});
    await message({});

    expect(attention()).toEqual([
      {
        ruleId: dead,
        name: "Dead",
        checkTypes: ["message"],
        versionNumber: 1,
        reasons: [{ kind: "never_matches", checks: 3, summary: "No matches in its last 3 checks." }],
      },
    ]);
  });

  it("judges reply-check rules on the replies they were scored against", async () => {
    thresholds({ quietChecks: 2 });
    const handover = sandbox.liveRule({ name: "Handover", checkType: "reply", conditions: ["No link."] });
    await message({});
    await message({});
    await reply({});
    expect(attention()).toEqual([]);

    await reply({});

    expect(attention()).toMatchObject([
      { ruleId: handover, checkTypes: ["reply"], reasons: [{ kind: "never_matches", checks: 2 }] },
    ]);
  });

  describe("a rule in both checks", () => {
    const ruleInBothChecks = () =>
      sandbox.liveRule({
        name: "Local link",
        conditions: [
          { text: "Asks for a visual change.", message: true, reply: false },
          { text: "Reports a change with no link.", message: false, reply: true },
        ],
      });

    it("judges each weak match at the cutoff of the check it came from", async () => {
      thresholds({ busyShare: 1, closeMargin: 0.05, cutoff: 0.6, replyCutoff: 0.8 });
      const ruleId = ruleInBothChecks();
      // Far above the message cutoff, though close above the reply cutoff: not weak.
      await message({ "Asks for a visual change.": 0.82 });
      // Close above the reply cutoff, though far above the message cutoff: weak.
      await reply({ "Reports a change with no link.": 0.83 });
      await message({});

      expect(attention()).toMatchObject([
        {
          ruleId,
          checkTypes: ["message", "reply"],
          reasons: [{ kind: "weak_matches", weakMatches: 1, matches: 2 }],
        },
      ]);
    });

    it("is listed once, with the reasons from both checks together", async () => {
      thresholds({ quietChecks: 3 });
      const ruleId = ruleInBothChecks();
      await message({});
      await reply({});
      expect(attention()).toEqual([]);

      await message({});

      expect(attention()).toEqual([
        {
          ruleId,
          name: "Local link",
          checkTypes: ["message", "reply"],
          versionNumber: 1,
          reasons: [{ kind: "never_matches", checks: 3, summary: "No matches in its last 3 checks." }],
        },
      ]);
    });
  });

  it("starts a rule's record afresh when a new version is published", async () => {
    thresholds({ quietChecks: 2 });
    const ruleId = sandbox.liveRule({ name: "Reworded", conditions: ["Old wording."] });
    await message({});
    await message({});
    expect(attention().map((entry) => entry.name)).toEqual(["Reworded"]);

    sandbox.withRules((rules) => {
      rules.saveDraft(ruleId, { instruction: "Do it.", conditions: conditionsFor("message", ["New wording."]) });
      rules.publish(ruleId);
    });
    await message({});
    expect(attention()).toEqual([]);
  });

  it("leaves out rules that are switched off, never published or deleted", async () => {
    thresholds({ quietChecks: 1 });
    const off = sandbox.liveRule({ name: "Off", conditions: ["Condition A."] });
    const gone = sandbox.liveRule({ name: "Gone", conditions: ["Condition B."] });
    sandbox.withRules((rules) =>
      rules.createRule({ name: "Draft", instruction: "Do X.", conditions: conditionsFor("message", ["Condition C."]) }),
    );
    await message({});
    sandbox.withRules((rules) => {
      rules.switchOff(off);
      rules.deleteRule(gone);
    });

    expect(attention()).toEqual([]);
  });

  it("lists a rule whose live version has matches flagged as wrong matches", async () => {
    thresholds({ busyShare: 1 });
    const wrong = sandbox.liveRule({ name: "Wrong matches", conditions: ["Condition A."] });
    const right = sandbox.liveRule({ name: "Fine", conditions: ["Condition B."] });
    await message({ "Condition A.": 0.9, "Condition B.": 0.9 });
    await message({ "Condition A.": 0.9 });
    await message({});
    const [first, second] = matchesOf(wrong);
    flag(first!, "wrong");
    flag(second!, "wrong");
    flag(matchesOf(right)[0]!, "right");

    expect(attention()).toEqual([
      {
        ruleId: wrong,
        name: "Wrong matches",
        checkTypes: ["message"],
        versionNumber: 1,
        reasons: [{ kind: "wrong_matches", flags: 2, summary: "2 matches of version 1 flagged as a wrong match." }],
      },
    ]);

    // A new version has no wrong matches yet.
    sandbox.withRules((rules) => {
      rules.saveDraft(wrong, { instruction: "Do it.", conditions: conditionsFor("message", ["Sharper condition."]) });
      rules.publish(wrong);
    });
    expect(attention()).toEqual([]);
  });

  it("lists every reason for a rule, and the worst cases first", async () => {
    thresholds({ recentChecks: 2, busyShare: 0.5, quietChecks: 2 });
    const flaggedWrong = sandbox.liveRule({ name: "Wrong matches", conditions: ["Condition A."] });
    const quiet = sandbox.liveRule({ name: "A quiet rule", conditions: ["Condition B."] });
    const weak = sandbox.liveRule({ name: "B weak and eager", conditions: ["Condition C."] });
    await message({ "Condition A.": 0.9, "Condition C.": 0.61 });
    await message({ "Condition C.": 0.9 });
    flag(matchesOf(flaggedWrong)[0]!, "wrong");

    const entries = attention();
    expect(entries.map((entry) => [entry.ruleId, entry.reasons.map((reason) => reason.kind)])).toEqual([
      [flaggedWrong, ["wrong_matches", "matches_often"]],
      [weak, ["matches_often", "weak_matches"]],
      [quiet, ["never_matches"]],
    ]);
  });

  describe("looks fine", () => {
    const clear = (ruleId: number, kind: AttentionKind) =>
      sandbox.withRules((rules) => rules.clearAttentionReason(ruleId, kind));
    const kindsOf = (ruleId: number) =>
      attention()
        .find((entry) => entry.ruleId === ruleId)
        ?.reasons.map((reason) => reason.kind);

    it("refuses to clear a reason for a version other than the live one", async () => {
      thresholds({ quietChecks: 1 });
      const ruleId = sandbox.liveRule({ name: "Reworded", conditions: ["Old wording."] });
      sandbox.withRules((rules) => {
        rules.saveDraft(ruleId, { instruction: "Do it.", conditions: conditionsFor("message", ["New wording."]) });
        rules.publish(ruleId);
      });
      await message({});
      expect(kindsOf(ruleId)).toEqual(["never_matches"]);

      // The list the user looked at showed version 1; version 2 has not been judged.
      expect(() => sandbox.withRules((rules) => rules.clearAttentionReason(ruleId, "never_matches", 1))).toThrow(RuleError);
      expect(kindsOf(ruleId)).toEqual(["never_matches"]);

      sandbox.withRules((rules) => rules.clearAttentionReason(ruleId, "never_matches", 2));
      expect(kindsOf(ruleId)).toBeUndefined();
    });

    it("clears one reason of several, for that rule only", async () => {
      thresholds({ recentChecks: 2, busyShare: 0.5 });
      const rule = sandbox.liveRule({ name: "Weak and eager", conditions: ["Condition A."] });
      const other = sandbox.liveRule({ name: "Also eager", conditions: ["Condition B."] });
      await message({ "Condition A.": 0.61, "Condition B.": 0.9 });
      await message({ "Condition A.": 0.9, "Condition B.": 0.9 });
      expect(kindsOf(rule)).toEqual(["matches_often", "weak_matches"]);

      clear(rule, "matches_often");

      expect(kindsOf(rule)).toEqual(["weak_matches"]);
      expect(kindsOf(other)).toEqual(["matches_often"]);
      expect(sandbox.query("SELECT v.rule_id, c.kind FROM cleared_reasons c JOIN versions v ON v.id = c.version_id")).toEqual([
        { rule_id: rule, kind: "matches_often" },
      ]);
      // It stays cleared as more checks come in, and clearing it again changes nothing.
      await message({ "Condition A.": 0.61 });
      clear(rule, "matches_often");
      expect(kindsOf(rule)).toEqual(["weak_matches"]);
    });

    it("takes the rule off the list when its last reason is cleared", async () => {
      thresholds({ quietChecks: 2 });
      const quiet = sandbox.liveRule({ name: "Quiet", conditions: ["Condition A."] });
      await message({});
      await message({});
      expect(kindsOf(quiet)).toEqual(["never_matches"]);

      clear(quiet, "never_matches");

      expect(attention()).toEqual([]);
    });

    it("lets the reason come back once a new version is published", async () => {
      thresholds({ quietChecks: 2 });
      const quiet = sandbox.liveRule({ name: "Quiet", conditions: ["Old wording."] });
      await message({});
      await message({});
      clear(quiet, "never_matches");
      expect(attention()).toEqual([]);

      sandbox.withRules((rules) => {
        rules.saveDraft(quiet, { instruction: "Do it.", conditions: conditionsFor("message", ["New wording."]) });
        rules.publish(quiet);
      });
      await message({});
      await message({});

      expect(attention()).toMatchObject([{ ruleId: quiet, versionNumber: 2, reasons: [{ kind: "never_matches" }] }]);
    });

    it("refuses wrong matches, which stay listed", async () => {
      thresholds({ busyShare: 1 });
      const wrong = sandbox.liveRule({ name: "Wrong matches", conditions: ["Condition A."] });
      await message({ "Condition A.": 0.9 });
      await message({});
      flag(matchesOf(wrong)[0]!, "wrong");

      expect(() => clear(wrong, "wrong_matches")).toThrow(RuleError);
      expect(kindsOf(wrong)).toEqual(["wrong_matches"]);
    });

    it("refuses an unknown rule, an unknown reason and a reason the rule is not listed for", async () => {
      thresholds({ quietChecks: 2 });
      const quiet = sandbox.liveRule({ name: "Quiet", conditions: ["Condition A."] });
      await message({});
      await message({});

      expect(() => clear(999, "never_matches")).toThrow(RuleNotFoundError);
      expect(() => clear(quiet, "looks_odd" as AttentionKind)).toThrow(RuleError);
      expect(() => clear(quiet, "matches_often")).toThrow(RuleError);
      expect(kindsOf(quiet)).toEqual(["never_matches"]);
      expect(sandbox.query("SELECT * FROM cleared_reasons")).toEqual([]);
    });
  });
});
