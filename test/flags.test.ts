import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleAnalytics } from "../src/analytics.ts";
import type { FlagResult, SavedCaseView } from "../src/flags.ts";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { RuleError, RuleNotFoundError } from "../src/rules.ts";
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

/** Runs the `wrong-match` command as Claude would, from inside a Claude Code session. */
const wrongMatch = (args: string[], sessionId: string | null = "session-1") =>
  spawnSync(process.execPath, [cli, "wrong-match", ...args], {
    encoding: "utf8",
    env: sandbox.childEnv(sessionId === null ? {} : { CLAUDE_CODE_SESSION_ID: sessionId }),
  });

const analytics = (ruleId: number): RuleAnalytics => sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
const cases = (ruleId: number): SavedCaseView[] => sandbox.withRules((rules) => rules.savedCases(ruleId));
/** The rule's matches, oldest first, with each one's text and flag. */
const matches = (ruleId: number) =>
  analytics(ruleId)
    .recentMatches.map((f) => ({ id: f.matchId, text: f.text, flag: f.flag && { verdict: f.flag.verdict, raisedBy: f.flag.raisedBy } }))
    .reverse();

describe("Claude's wrong-match report", () => {
  it("runs as the attached text writes it, from the folder Claude works in", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    const output = await message("make the button blue", standInMatcher({ "Asks for a visual change.": 0.8 }));
    const attached: string = JSON.parse(output).hookSpecificOutput.additionalContext;
    const command = /leave it out of your reply: (.+)$/.exec(attached)![1]!.replace("<rule name>", "Local link");

    expect(command).toBe(`node "${cli.replaceAll("\\", "/")}" wrong-match "Local link"`);
    const project = join(sandbox.root, "some project");
    mkdirSync(project);
    const result = spawnSync(command, {
      shell: true,
      cwd: project,
      encoding: "utf8",
      env: sandbox.childEnv({ CLAUDE_CODE_SESSION_ID: "session-1" }),
    });
    expect(result.stdout).toBe('Recorded a wrong match for "Local link".\n');
    expect(matches(ruleId).map((m) => m.flag)).toEqual([{ verdict: "wrong", raisedBy: "claude" }]);
  });

  it("flags the session's most recent match of the rule as a wrong match raised by Claude", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    const matcher = standInMatcher({ "Asks for a visual change.": 0.8 });
    await message("first in session one", matcher);
    await message("second in session one", matcher);
    await message("later, in session two", matcher, "session-2");

    const result = wrongMatch(["Local link"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Recorded a wrong match for "Local link".\n');
    expect(matches(ruleId)).toEqual([
      { id: expect.any(Number), text: "first in session one", flag: null },
      { id: expect.any(Number), text: "second in session one", flag: { verdict: "wrong", raisedBy: "claude" } },
      { id: expect.any(Number), text: "later, in session two", flag: null },
    ]);
    expect(cases(ruleId)).toMatchObject([
      {
        ruleId,
        checkType: "message",
        text: "second in session one",
        expected: "should_not_match",
        source: { verdict: "wrong", raisedBy: "claude", versionNumber: 1 },
      },
    ]);
  });

  it("takes the name as Claude saw it, ignoring case, among several rules that matched", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    const stronger = sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    await message("both matched", standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.9 }));

    const result = wrongMatch(["local", "LINK"]);

    expect(result.status).toBe(0);
    expect(matches(ruleId).map((f) => [f.text, f.flag?.verdict ?? null])).toEqual([["both matched", "wrong"]]);
    expect(matches(stronger).map((f) => [f.text, f.flag?.verdict ?? null])).toEqual([["both matched", null]]);
  });

  it("refuses, recording nothing, when the rule has not matched in the session or there is no session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    const notMatched = wrongMatch(["Local link"]);
    expect(notMatched.status).toBe(1);
    expect(notMatched.stderr).toBe('No rule named "Local link" has matched in this session.\n');
    expect(wrongMatch(["Unknown rule"], "session-2").status).toBe(1);
    const noSession = wrongMatch(["Local link"], null);
    expect(noSession.status).toBe(1);
    expect(noSession.stderr).toContain("No session");
    const noName = wrongMatch([]);
    expect(noName.status).toBe(1);
    // The retry it suggests runs from Claude's folder too.
    expect(noName.stderr).toContain(`Usage: node "${cli.replaceAll("\\", "/")}" wrong-match "<rule name>"`);

    expect(matches(ruleId)[0]!.flag).toBeNull();
    expect(cases(ruleId)).toEqual([]);
  });

  it("names a session with --session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    expect(wrongMatch(["Local link", "--session", "session-2"], null).status).toBe(0);
    expect(matches(ruleId)[0]!.flag).toEqual({ verdict: "wrong", raisedBy: "claude" });
  });
});

describe("flags and saved cases", () => {
  it("records who raised each flag and keeps a saved case with the expected outcome", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.8 });
    await message("one", matcher);
    await message("two", matcher);
    const [one, two] = matches(ruleId);

    sandbox.withRules((rules) => {
      rules.flagMatch(one!.id, "right", "user");
      rules.flagMatch(two!.id, "wrong", "claude");
    });

    expect(matches(ruleId).map((f) => f.flag)).toEqual([
      { verdict: "right", raisedBy: "user" },
      { verdict: "wrong", raisedBy: "claude" },
    ]);
    expect(cases(ruleId).map((c) => [c.text, c.expected, c.source?.raisedBy])).toEqual([
      ["two", "should_not_match", "claude"],
      ["one", "should_match", "user"],
    ]);
  });

  it("holds one flag per match: a new one replaces the old and its case, but never the user's own", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [match] = matches(ruleId);

    sandbox.withRules((rules) => rules.flagMatch(match!.id, "wrong", "claude"));
    sandbox.withRules((rules) => rules.flagMatch(match!.id, "right", "user"));
    expect(matches(ruleId)[0]!.flag).toEqual({ verdict: "right", raisedBy: "user" });
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_match"]);

    expect(wrongMatch(["Rule"]).stdout).toContain("already marked");
    const kept = sandbox.withRules((rules) => rules.flagMatch(match!.id, "wrong", "claude"));
    expect(kept).toMatchObject({ recorded: false, flag: { verdict: "right", raisedBy: "user" } });
    expect(matches(ruleId)[0]!.flag).toEqual({ verdict: "right", raisedBy: "user" });
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_match"]);

    sandbox.withRules((rules) => rules.flagMatch(match!.id, "wrong", "user"));
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_not_match"]);
  });

  it("shows each version's wrong-match count", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.8 });
    await message("on version one", matcher);
    sandbox.withRules((rules) => {
      rules.saveDraft(ruleId, { instruction: "Do it.", conditions: ["Condition B."] });
      rules.publish(ruleId);
    });
    await message("first on version two", matcher);
    await message("second on version two", matcher);
    const [v1, v2a, v2b] = matches(ruleId);

    sandbox.withRules((rules) => {
      rules.flagMatch(v1!.id, "wrong", "user");
      rules.flagMatch(v2a!.id, "wrong", "claude");
      rules.flagMatch(v2b!.id, "right", "user");
    });

    const result = analytics(ruleId);
    expect(result.wrongMatches).toBe(2);
    expect(result.versions).toMatchObject([
      { number: 2, matches: 2, wrongMatches: 1 },
      { number: 1, matches: 1, wrongMatches: 1 },
    ]);
  });

  it("works for reply-check rules: Claude's report and the user's marks keep the reply as a saved case", async () => {
    const ruleId = sandbox.liveRule({ name: "Handover link", checkType: "reply", conditions: ["No link given."] });
    const matcher = standInMatcher({ "No link given.": 0.9 });
    await reply("Done, the header is smaller.", matcher);
    await reply("Done, see the footer.", matcher, "session-2");

    expect(wrongMatch(["Handover link"]).status).toBe(0);
    const [, second] = matches(ruleId);
    sandbox.withRules((rules) => rules.flagMatch(second!.id, "right", "user"));

    expect(cases(ruleId)).toMatchObject([
      { checkType: "reply", text: "Done, see the footer.", expected: "should_match", source: { raisedBy: "user" } },
      {
        checkType: "reply",
        text: "Done, the header is smaller.",
        expected: "should_not_match",
        source: { raisedBy: "claude" },
      },
    ]);
  });

  it("refuses an unknown match, verdict or raiser, and a rule's cases go with the rule", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [match] = matches(ruleId);

    sandbox.withRules((rules) => {
      expect(() => rules.flagMatch(999, "wrong", "user")).toThrow(RuleNotFoundError);
      expect(() => rules.flagMatch(match!.id, "maybe" as "wrong", "user")).toThrow(RuleError);
      expect(() => rules.flagMatch(match!.id, "wrong", "someone" as "user")).toThrow(RuleError);
      expect(() => rules.savedCases(999)).toThrow(RuleNotFoundError);
      rules.flagMatch(match!.id, "wrong", "user");
      rules.deleteRule(ruleId);
      expect(() => rules.flagMatch(match!.id, "right", "user")).toThrow(RuleNotFoundError);
    });
    expect(sandbox.query("SELECT * FROM saved_cases")).toEqual([]);

    // A new rule does not inherit the deleted rule's matches.
    const newRuleId = sandbox.liveRule({ name: "Replacement", conditions: ["Condition B."] });
    expect(newRuleId).not.toBe(ruleId);
    sandbox.withRules((rules) => {
      expect(() => rules.flagMatch(match!.id, "right", "user")).toThrow(RuleNotFoundError);
    });
    expect(matches(newRuleId)).toEqual([]);
    expect(sandbox.query("SELECT * FROM saved_cases")).toEqual([]);
  });
});

describe("flags over HTTP", () => {
  let app: RunningApp;
  beforeEach(async () => {
    app = await startApp(sandbox);
  });
  afterEach(() => app.close());

  it("marks a match wrong or right with one call each, and serves the rule's saved cases", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const { recentMatches } = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    const matchId = recentMatches[0]!.matchId;

    const wrong = await app.json<FlagResult>("POST", `/api/matches/${matchId}/flag`, { verdict: "wrong" });
    expect(wrong).toMatchObject({ ruleId, matchId, recorded: true, flag: { verdict: "wrong", raisedBy: "user" } });
    const after = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    expect(after).toMatchObject({ wrongMatches: 1, recentMatches: [{ flag: { verdict: "wrong", raisedBy: "user" } }] });

    await app.json("POST", `/api/matches/${matchId}/flag`, { verdict: "right" });
    const { cases: served } = await app.json<{ cases: SavedCaseView[] }>("GET", `/api/rules/${ruleId}/cases`);
    expect(served).toMatchObject([{ text: "hello there", expected: "should_match", source: { raisedBy: "user" } }]);

    expect((await app.call("POST", `/api/matches/${matchId}/flag`, { verdict: "maybe" })).status).toBe(400);
    expect((await app.call("POST", `/api/matches/${matchId}/flag`, { verdict: "wrong", raisedBy: "claude" })).status).toBe(200);
    expect((await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`)).recentMatches[0]!.flag).toMatchObject({
      raisedBy: "user",
    });
    expect((await app.call("POST", "/api/matches/999/flag", { verdict: "wrong" })).status).toBe(404);
    expect((await app.call("GET", "/api/rules/999/cases")).status).toBe(404);
  });
});
