import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import type { Settings } from "../src/rules.ts";
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
 * Flags a firing as the flags feature records it. Until that feature has
 * landed the table may not exist yet, so it is created here when missing.
 */
function flag(firingId: number, verdict: "wrong" | "correct"): void {
  const db = new DatabaseSync(databasePath(sandbox.env));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS flags (
      id          INTEGER PRIMARY KEY,
      firing_id   INTEGER NOT NULL UNIQUE REFERENCES firings (id) ON DELETE CASCADE,
      verdict     TEXT NOT NULL CHECK (verdict IN ('wrong', 'correct')),
      raised_by   TEXT NOT NULL CHECK (raised_by IN ('claude', 'user', 'automatic')),
      created_at  TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO flags (firing_id, verdict, raised_by, created_at) VALUES (?, ?, 'user', ?)").run(
      firingId,
      verdict,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

const firingsOf = (ruleId: number) =>
  sandbox.query<{ id: number }>("SELECT id FROM firings WHERE rule_id = ? ORDER BY id", ruleId).map((row) => row.id);

describe("needs attention", () => {
  it("lists nothing while every rule behaves", async () => {
    sandbox.liveRule({ name: "Steady", conditions: ["Condition A."] });
    await message({ "Condition A.": 0.9 });
    for (let i = 0; i < 4; i++) await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([]);
  });

  it("lists a rule that fires on a large share of its recent checks, and says why", async () => {
    thresholds({ recentChecks: 4, busyShare: 0.5 });
    const eager = sandbox.liveRule({ name: "Eager", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Calm", conditions: ["Condition B."] });
    // Eager fires on checks 1, 3 and 4; only the latest four count, so 2 of 4.
    await message({ "Condition A.": 0.9, "Condition B.": 0.9 });
    await message({ "Condition A.": 0.1 });
    await message({ "Condition A.": 0.9 });
    await message({ "Condition A.": 0.9 });
    await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([
      {
        ruleId: eager,
        name: "Eager",
        checkType: "message",
        versionNumber: 1,
        reasons: [
          {
            kind: "fires_often",
            firings: 2,
            checks: 4,
            share: 0.5,
            threshold: 0.5,
            summary: "Fired on 2 of its last 4 checks (50%); the threshold is 50%.",
          },
        ],
      },
    ]);
  });

  it("does not list a rule firing on less than the share", async () => {
    thresholds({ recentChecks: 4, busyShare: 0.5 });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message({ "Condition A.": 0.9 });
    for (let i = 0; i < 3; i++) await message({ "Condition A.": 0.1 });

    expect(attention()).toEqual([]);
  });

  it("lists a rule whose firings score close above the cutoff, judged against the cutoff in force", async () => {
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
            kind: "close_to_cutoff",
            closeFirings: 2,
            firings: 3,
            margin: 0.05,
            summary: "2 of its 3 recent firings scored no more than 0.05 above the cutoff.",
          },
        ],
      },
    ]);
  });

  it("counts firings the cap dropped, since they fired all the same", async () => {
    thresholds({ cap: 1, busyShare: 1 });
    const dropped = sandbox.liveRule({ name: "Dropped", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Kept", conditions: ["Condition B."] });
    await message({ "Condition A.": 0.62, "Condition B.": 0.95 });
    await message({});

    expect(attention()).toMatchObject([{ ruleId: dropped, reasons: [{ kind: "close_to_cutoff", closeFirings: 1 }] }]);
  });

  it("lists a rule with no firings over a long stretch of checks, once it has had that many", async () => {
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
        checkType: "message",
        versionNumber: 1,
        reasons: [{ kind: "never_fires", checks: 3, summary: "No firings in its last 3 checks." }],
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
      { ruleId: handover, checkType: "reply", reasons: [{ kind: "never_fires", checks: 2 }] },
    ]);
  });

  it("starts a rule's record afresh when a new version is published", async () => {
    thresholds({ quietChecks: 2 });
    const ruleId = sandbox.liveRule({ name: "Reworded", conditions: ["Old wording."] });
    await message({});
    await message({});
    expect(attention().map((entry) => entry.name)).toEqual(["Reworded"]);

    sandbox.withRules((rules) => {
      rules.saveDraft(ruleId, { instruction: "Do it.", conditions: ["New wording."] });
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
      rules.createRule({ name: "Draft", checkType: "message", instruction: "Do X.", conditions: ["Condition C."] }),
    );
    await message({});
    sandbox.withRules((rules) => {
      rules.switchOff(off);
      rules.deleteRule(gone);
    });

    expect(attention()).toEqual([]);
  });

  it("lists a rule whose live version has firings flagged as wrong matches", async () => {
    thresholds({ busyShare: 1 });
    const wrong = sandbox.liveRule({ name: "Misfires", conditions: ["Condition A."] });
    const right = sandbox.liveRule({ name: "Fine", conditions: ["Condition B."] });
    await message({ "Condition A.": 0.9, "Condition B.": 0.9 });
    await message({ "Condition A.": 0.9 });
    await message({});
    const [first, second] = firingsOf(wrong);
    flag(first!, "wrong");
    flag(second!, "wrong");
    flag(firingsOf(right)[0]!, "correct");

    expect(attention()).toEqual([
      {
        ruleId: wrong,
        name: "Misfires",
        checkType: "message",
        versionNumber: 1,
        reasons: [{ kind: "wrong_matches", flags: 2, summary: "2 firings of version 1 flagged as a wrong match." }],
      },
    ]);

    // A new version has not misfired yet.
    sandbox.withRules((rules) => {
      rules.saveDraft(wrong, { instruction: "Do it.", conditions: ["Sharper condition."] });
      rules.publish(wrong);
    });
    expect(attention()).toEqual([]);
  });

  it("lists every reason for a rule, and the worst cases first", async () => {
    thresholds({ recentChecks: 2, busyShare: 0.5, quietChecks: 2 });
    const misfires = sandbox.liveRule({ name: "Misfires", conditions: ["Condition A."] });
    const quiet = sandbox.liveRule({ name: "A quiet rule", conditions: ["Condition B."] });
    const weak = sandbox.liveRule({ name: "B weak and eager", conditions: ["Condition C."] });
    await message({ "Condition A.": 0.9, "Condition C.": 0.61 });
    await message({ "Condition C.": 0.9 });
    flag(firingsOf(misfires)[0]!, "wrong");

    const entries = attention();
    expect(entries.map((entry) => [entry.ruleId, entry.reasons.map((reason) => reason.kind)])).toEqual([
      [misfires, ["wrong_matches", "fires_often"]],
      [weak, ["fires_often", "close_to_cutoff"]],
      [quiet, ["never_fires"]],
    ]);
  });
});
