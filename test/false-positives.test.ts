import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleAnalytics } from "../src/analytics.ts";
import type { FalsePositive, MarkResult } from "../src/false-positives.ts";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { conditionsFor, RuleError, RuleNotFoundError } from "../src/rules.ts";
import { type RunningApp, startApp } from "./support/app.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { type StandIn, standInMatcher } from "./support/stand-in-matcher.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const message = (prompt: string, matcher: StandIn, sessionId = "session-1") =>
  runMessageHook(hookInput(prompt, { session_id: sessionId }), { env: sandbox.env, matcher });

const reply = (text: string, matcher: StandIn, sessionId = "session-1") =>
  runReplyHook(
    JSON.stringify({
      session_id: sessionId,
      transcript_path: join(sandbox.root, "missing.jsonl"),
      cwd: "/work/project",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: text,
    }),
    { env: sandbox.env, matcher },
  );

/** Runs the `false-positive` command as Claude would, from inside a Claude Code session. */
const report = (args: string[], sessionId: string | null = "session-1", command = "false-positive") =>
  spawnSync(process.execPath, [cli, command, ...args], {
    encoding: "utf8",
    env: sandbox.childEnv(sessionId === null ? {} : { CLAUDE_CODE_SESSION_ID: sessionId }),
  });

const analytics = (ruleId: number): RuleAnalytics => sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
const falsePositives = (ruleId: number): FalsePositive[] => sandbox.withRules((rules) => rules.falsePositives(ruleId));
/** The rule's matches, oldest first, with each one's text and who marked it a false positive. */
const matches = (ruleId: number) =>
  analytics(ruleId)
    .recentMatches.map((f) => ({ id: f.matchId, text: f.text, markedBy: f.falsePositive?.markedBy ?? null }))
    .reverse();

describe("Claude's false-positive report", () => {
  it("runs as the attached text writes it, from the folder Claude works in", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    const output = await message("make the button blue", standInMatcher({ "Asks for a visual change.": 0.8 }));
    const attached: string = JSON.parse(output).hookSpecificOutput.additionalContext;
    const command = /leave it out of your reply: (.+)$/.exec(attached)![1]!.replace("<rule name>", "Local link");

    expect(command).toBe(`node "${cli.replaceAll("\\", "/")}" false-positive "Local link"`);
    const project = join(sandbox.root, "some project");
    mkdirSync(project);
    const result = spawnSync(command, {
      shell: true,
      cwd: project,
      encoding: "utf8",
      env: sandbox.childEnv({ CLAUDE_CODE_SESSION_ID: "session-1" }),
    });
    expect(result.stdout).toBe('Recorded a false positive for "Local link".\n');
    expect(matches(ruleId).map((m) => m.markedBy)).toEqual(["claude"]);
  });

  it("marks the session's most recent match of the rule as a false positive by Claude", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    const matcher = standInMatcher({ "Asks for a visual change.": 0.8 });
    await message("first in session one", matcher);
    await message("second in session one", matcher);
    await message("later, in session two", matcher, "session-2");

    const result = report(["Local link"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Recorded a false positive for "Local link".\n');
    expect(matches(ruleId)).toEqual([
      { id: expect.any(Number), text: "first in session one", markedBy: null },
      { id: expect.any(Number), text: "second in session one", markedBy: "claude" },
      { id: expect.any(Number), text: "later, in session two", markedBy: null },
    ]);
    expect(falsePositives(ruleId)).toMatchObject([
      { ruleId, checkType: "message", text: "second in session one", markedBy: "claude", versionNumber: 1 },
    ]);
  });

  it("still answers to its old name, wrong-match", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));

    expect(report(["Local link"], "session-1", "wrong-match").status).toBe(0);
    expect(matches(ruleId)[0]!.markedBy).toBe("claude");
  });

  it("takes the name as Claude saw it, ignoring case, among several rules that matched", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    const stronger = sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    await message("both matched", standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.9 }));

    const result = report(["local", "LINK"]);

    expect(result.status).toBe(0);
    expect(matches(ruleId).map((f) => [f.text, f.markedBy])).toEqual([["both matched", "claude"]]);
    expect(matches(stronger).map((f) => [f.text, f.markedBy])).toEqual([["both matched", null]]);
  });

  it("refuses, recording nothing, when the rule has not matched in the session or there is no session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    const notMatched = report(["Local link"]);
    expect(notMatched.status).toBe(1);
    expect(notMatched.stderr).toBe('No rule named "Local link" has matched in this session.\n');
    expect(report(["Unknown rule"], "session-2").status).toBe(1);
    const noSession = report(["Local link"], null);
    expect(noSession.status).toBe(1);
    expect(noSession.stderr).toContain("No session");
    const noName = report([]);
    expect(noName.status).toBe(1);
    // The retry it suggests runs from Claude's folder too.
    expect(noName.stderr).toContain(`Usage: node "${cli.replaceAll("\\", "/")}" false-positive "<rule name>"`);

    expect(matches(ruleId)[0]!.markedBy).toBeNull();
    expect(falsePositives(ruleId)).toEqual([]);
  });

  it("names a session with --session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    expect(report(["Local link", "--session", "session-2"], null).status).toBe(0);
    expect(matches(ruleId)[0]!.markedBy).toBe("claude");
  });
});

describe("false positives", () => {
  it("records who marked each one, newest first", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.8 });
    await message("one", matcher);
    await message("two", matcher);
    await message("three", matcher);
    const [one, two] = matches(ruleId);

    sandbox.withRules((rules) => {
      rules.markFalsePositive(one!.id, "user");
      rules.markFalsePositive(two!.id, "claude");
    });

    expect(matches(ruleId).map((f) => f.markedBy)).toEqual(["user", "claude", null]);
    expect(falsePositives(ruleId).map((f) => [f.text, f.markedBy])).toEqual([
      ["two", "claude"],
      ["one", "user"],
    ]);
  });

  it("holds one mark per match: the user's replaces Claude's, never the other way round", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [match] = matches(ruleId);

    sandbox.withRules((rules) => rules.markFalsePositive(match!.id, "claude"));
    const again = sandbox.withRules((rules) => rules.markFalsePositive(match!.id, "claude"));
    expect(again).toMatchObject({ recorded: false, mark: { markedBy: "claude" } });

    const mine = sandbox.withRules((rules) => rules.markFalsePositive(match!.id, "user"));
    expect(mine).toMatchObject({ recorded: true, mark: { markedBy: "user" } });
    expect(report(["Rule"]).stdout).toBe('That match of "Rule" is already marked as a false positive.\n');
    expect(falsePositives(ruleId).map((f) => f.markedBy)).toEqual(["user"]);
  });

  it("lets the user take a mark away, whoever made it", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    expect(report(["Rule"]).status).toBe(0);
    const [match] = matches(ruleId);

    sandbox.withRules((rules) => rules.unmarkFalsePositive(match!.id));
    expect(matches(ruleId)[0]!.markedBy).toBeNull();
    expect(falsePositives(ruleId)).toEqual([]);
    // Taking away a mark that is not there changes nothing.
    sandbox.withRules((rules) => rules.unmarkFalsePositive(match!.id));
    expect(falsePositives(ruleId)).toEqual([]);
  });

  it("shows each version's false-positive count", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.8 });
    await message("on version one", matcher);
    sandbox.withRules((rules) => {
      rules.saveDraft(ruleId, { instruction: "Do it.", conditions: conditionsFor("message", ["Condition B."]) });
      rules.publish(ruleId);
    });
    await message("first on version two", matcher);
    await message("second on version two", matcher);
    const [v1, v2a] = matches(ruleId);

    sandbox.withRules((rules) => {
      rules.markFalsePositive(v1!.id, "user");
      rules.markFalsePositive(v2a!.id, "claude");
    });

    const result = analytics(ruleId);
    expect(result.falsePositives).toBe(2);
    expect(result.versions).toMatchObject([
      { number: 2, matches: 2, falsePositives: 1 },
      { number: 1, matches: 1, falsePositives: 1 },
    ]);
  });

  it("works for reply-check rules: Claude's report and the user's marks keep the reply", async () => {
    const ruleId = sandbox.liveRule({ name: "Handover link", checkType: "reply", conditions: ["No link given."] });
    const matcher = standInMatcher({ "No link given.": 0.9 });
    await reply("Done, the header is smaller.", matcher);
    await reply("Done, see the footer.", matcher, "session-2");

    expect(report(["Handover link"]).status).toBe(0);
    const [, second] = matches(ruleId);
    sandbox.withRules((rules) => rules.markFalsePositive(second!.id, "user"));

    expect(falsePositives(ruleId)).toMatchObject([
      { checkType: "reply", text: "Done, see the footer.", markedBy: "user" },
      { checkType: "reply", text: "Done, the header is smaller.", markedBy: "claude" },
    ]);
  });

  it("refuses an unknown match or marker, and a deleted rule's matches can no longer be marked", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [match] = matches(ruleId);

    sandbox.withRules((rules) => {
      expect(() => rules.markFalsePositive(999, "user")).toThrow(RuleNotFoundError);
      expect(() => rules.unmarkFalsePositive(999)).toThrow(RuleNotFoundError);
      expect(() => rules.markFalsePositive(match!.id, "someone" as "user")).toThrow(RuleError);
      expect(() => rules.falsePositives(999)).toThrow(RuleNotFoundError);
      rules.markFalsePositive(match!.id, "user");
      rules.deleteRule(ruleId);
      expect(() => rules.markFalsePositive(match!.id, "user")).toThrow(RuleNotFoundError);
      expect(() => rules.falsePositives(ruleId)).toThrow(RuleNotFoundError);
    });

    // A new rule does not inherit the deleted rule's matches.
    const newRuleId = sandbox.liveRule({ name: "Replacement", conditions: ["Condition B."] });
    expect(newRuleId).not.toBe(ruleId);
    sandbox.withRules((rules) => {
      expect(() => rules.markFalsePositive(match!.id, "user")).toThrow(RuleNotFoundError);
    });
    expect(matches(newRuleId)).toEqual([]);
    expect(falsePositives(newRuleId)).toEqual([]);
  });
});

describe("false positives over HTTP", () => {
  let app: RunningApp;
  beforeEach(async () => {
    app = await startApp(sandbox);
  });
  afterEach(() => app.close());

  it("marks a match and takes the mark away with one call each, and serves the rule's false positives", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const { recentMatches } = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    const matchId = recentMatches[0]!.matchId;

    const marked = await app.json<MarkResult>("POST", `/api/matches/${matchId}/false-positive`, {});
    expect(marked).toMatchObject({ ruleId, matchId, recorded: true, mark: { markedBy: "user" } });
    const after = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    expect(after).toMatchObject({ falsePositives: 1, recentMatches: [{ falsePositive: { markedBy: "user" } }] });
    const { falsePositives: served } = await app.json<{ falsePositives: FalsePositive[] }>(
      "GET",
      `/api/rules/${ruleId}/false-positives`,
    );
    expect(served).toMatchObject([{ matchId, text: "hello there", markedBy: "user" }]);

    expect(await app.json("DELETE", `/api/matches/${matchId}/false-positive`)).toEqual({ unmarked: true });
    const cleared = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    expect(cleared).toMatchObject({ falsePositives: 0, recentMatches: [{ falsePositive: null }] });

    expect((await app.call("POST", "/api/matches/999/false-positive", {})).status).toBe(404);
    expect((await app.call("DELETE", "/api/matches/999/false-positive")).status).toBe(404);
    expect((await app.call("GET", "/api/rules/999/false-positives")).status).toBe(404);
  });
});
