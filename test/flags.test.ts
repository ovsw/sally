import { spawnSync } from "node:child_process";
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

/** Runs `sally wrong-match` as Claude would, from inside a Claude Code session. */
const wrongMatch = (args: string[], sessionId: string | null = "session-1") =>
  spawnSync(process.execPath, [cli, "wrong-match", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...sandbox.env,
      ...(sessionId === null ? {} : { CLAUDE_CODE_SESSION_ID: sessionId }),
    },
  });

const analytics = (ruleId: number): RuleAnalytics => sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
const cases = (ruleId: number): SavedCaseView[] => sandbox.withRules((rules) => rules.savedCases(ruleId));
/** The rule's firings, oldest first, with each one's text and flag. */
const firings = (ruleId: number) =>
  analytics(ruleId)
    .recentFirings.map((f) => ({ id: f.firingId, text: f.text, flag: f.flag && { verdict: f.flag.verdict, raisedBy: f.flag.raisedBy } }))
    .reverse();

describe("Claude's wrong-match report", () => {
  it("flags the session's most recent firing of the rule as a wrong match raised by Claude", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    const matcher = standInMatcher({ "Asks for a visual change.": 0.8 });
    await message("first in session one", matcher);
    await message("second in session one", matcher);
    await message("later, in session two", matcher, "session-2");

    const result = wrongMatch(["Local link"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Recorded a wrong match for "Local link".\n');
    expect(firings(ruleId)).toEqual([
      { id: expect.any(Number), text: "first in session one", flag: null },
      { id: expect.any(Number), text: "second in session one", flag: { verdict: "wrong", raisedBy: "claude" } },
      { id: expect.any(Number), text: "later, in session two", flag: null },
    ]);
    expect(cases(ruleId)).toMatchObject([
      {
        ruleId,
        checkType: "message",
        text: "second in session one",
        expected: "should_not_fire",
        source: { verdict: "wrong", raisedBy: "claude", versionNumber: 1 },
      },
    ]);
  });

  it("takes the name as Claude saw it, ignoring case, and passes over firings the cap dropped", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ cap: 1 }));
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    await message("attached", standInMatcher({ "Condition A.": 0.8 }));
    await message("cut by the cap", standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.9 }));

    const result = wrongMatch(["local", "LINK"]);

    expect(result.status).toBe(0);
    expect(firings(ruleId).map((f) => [f.text, f.flag?.verdict ?? null])).toEqual([
      ["attached", "wrong"],
      ["cut by the cap", null],
    ]);
  });

  it("refuses, recording nothing, when the rule has not fired in the session or there is no session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    const notFired = wrongMatch(["Local link"]);
    expect(notFired.status).toBe(1);
    expect(notFired.stderr).toBe('No rule named "Local link" has fired in this session.\n');
    expect(wrongMatch(["Unknown rule"], "session-2").status).toBe(1);
    const noSession = wrongMatch(["Local link"], null);
    expect(noSession.status).toBe(1);
    expect(noSession.stderr).toContain("No session");
    expect(wrongMatch([]).status).toBe(1);

    expect(firings(ruleId)[0]!.flag).toBeNull();
    expect(cases(ruleId)).toEqual([]);
  });

  it("names a session with --session", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }), "session-2");

    expect(wrongMatch(["Local link", "--session", "session-2"], null).status).toBe(0);
    expect(firings(ruleId)[0]!.flag).toEqual({ verdict: "wrong", raisedBy: "claude" });
  });
});

describe("flags and saved cases", () => {
  it("records who raised each flag and keeps a saved case with the expected outcome", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.8 });
    await message("one", matcher);
    await message("two", matcher);
    const [one, two] = firings(ruleId);

    sandbox.withRules((rules) => {
      rules.flagFiring(one!.id, "correct", "user");
      rules.flagFiring(two!.id, "wrong", "automatic");
    });

    expect(firings(ruleId).map((f) => f.flag)).toEqual([
      { verdict: "correct", raisedBy: "user" },
      { verdict: "wrong", raisedBy: "automatic" },
    ]);
    expect(cases(ruleId).map((c) => [c.text, c.expected, c.source?.raisedBy])).toEqual([
      ["two", "should_not_fire", "automatic"],
      ["one", "should_fire", "user"],
    ]);
  });

  it("holds one flag per firing: a new one replaces the old and its case, but never the user's own", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [firing] = firings(ruleId);

    sandbox.withRules((rules) => rules.flagFiring(firing!.id, "wrong", "claude"));
    sandbox.withRules((rules) => rules.flagFiring(firing!.id, "correct", "user"));
    expect(firings(ruleId)[0]!.flag).toEqual({ verdict: "correct", raisedBy: "user" });
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_fire"]);

    expect(wrongMatch(["Rule"]).stdout).toContain("already marked");
    const kept = sandbox.withRules((rules) => rules.flagFiring(firing!.id, "wrong", "automatic"));
    expect(kept).toMatchObject({ recorded: false, flag: { verdict: "correct", raisedBy: "user" } });
    expect(firings(ruleId)[0]!.flag).toEqual({ verdict: "correct", raisedBy: "user" });
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_fire"]);

    sandbox.withRules((rules) => rules.flagFiring(firing!.id, "wrong", "user"));
    expect(cases(ruleId).map((c) => c.expected)).toEqual(["should_not_fire"]);
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
    const [v1, v2a, v2b] = firings(ruleId);

    sandbox.withRules((rules) => {
      rules.flagFiring(v1!.id, "wrong", "user");
      rules.flagFiring(v2a!.id, "wrong", "claude");
      rules.flagFiring(v2b!.id, "correct", "user");
    });

    const result = analytics(ruleId);
    expect(result.wrongMatches).toBe(2);
    expect(result.versions).toMatchObject([
      { number: 2, firings: 2, wrongMatches: 1 },
      { number: 1, firings: 1, wrongMatches: 1 },
    ]);
  });

  it("works for reply-check rules: Claude's report and the user's marks keep the reply as a saved case", async () => {
    const ruleId = sandbox.liveRule({ name: "Handover link", checkType: "reply", conditions: ["No link given."] });
    const matcher = standInMatcher({ "No link given.": 0.9 });
    await reply("Done, the header is smaller.", matcher);
    await reply("Done, see the footer.", matcher, "session-2");

    expect(wrongMatch(["Handover link"]).status).toBe(0);
    const [, second] = firings(ruleId);
    sandbox.withRules((rules) => rules.flagFiring(second!.id, "correct", "user"));

    expect(cases(ruleId)).toMatchObject([
      { checkType: "reply", text: "Done, see the footer.", expected: "should_fire", source: { raisedBy: "user" } },
      {
        checkType: "reply",
        text: "Done, the header is smaller.",
        expected: "should_not_fire",
        source: { raisedBy: "claude" },
      },
    ]);
  });

  it("refuses an unknown firing, verdict or raiser, and a rule's cases go with the rule", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const [firing] = firings(ruleId);

    sandbox.withRules((rules) => {
      expect(() => rules.flagFiring(999, "wrong", "user")).toThrow(RuleNotFoundError);
      expect(() => rules.flagFiring(firing!.id, "maybe" as "wrong", "user")).toThrow(RuleError);
      expect(() => rules.flagFiring(firing!.id, "wrong", "someone" as "user")).toThrow(RuleError);
      expect(() => rules.savedCases(999)).toThrow(RuleNotFoundError);
      rules.flagFiring(firing!.id, "wrong", "user");
      rules.deleteRule(ruleId);
      expect(() => rules.flagFiring(firing!.id, "correct", "user")).toThrow(RuleNotFoundError);
    });
    expect(sandbox.query("SELECT * FROM saved_cases")).toEqual([]);
  });
});

describe("flags over HTTP", () => {
  let app: RunningApp;
  beforeEach(async () => {
    app = await startApp(sandbox);
  });
  afterEach(() => app.close());

  it("marks a firing wrong or correct with one call each, and serves the rule's saved cases", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.8 }));
    const { recentFirings } = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    const firingId = recentFirings[0]!.firingId;

    const wrong = await app.json<FlagResult>("POST", `/api/firings/${firingId}/flag`, { verdict: "wrong" });
    expect(wrong).toMatchObject({ ruleId, firingId, recorded: true, flag: { verdict: "wrong", raisedBy: "user" } });
    const after = await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    expect(after).toMatchObject({ wrongMatches: 1, recentFirings: [{ flag: { verdict: "wrong", raisedBy: "user" } }] });

    await app.json("POST", `/api/firings/${firingId}/flag`, { verdict: "correct" });
    const { cases: served } = await app.json<{ cases: SavedCaseView[] }>("GET", `/api/rules/${ruleId}/cases`);
    expect(served).toMatchObject([{ text: "hello there", expected: "should_fire", source: { raisedBy: "user" } }]);

    expect((await app.call("POST", `/api/firings/${firingId}/flag`, { verdict: "maybe" })).status).toBe(400);
    expect((await app.call("POST", `/api/firings/${firingId}/flag`, { verdict: "wrong", raisedBy: "claude" })).status).toBe(200);
    expect((await app.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`)).recentFirings[0]!.flag).toMatchObject({
      raisedBy: "user",
    });
    expect((await app.call("POST", "/api/firings/999/flag", { verdict: "wrong" })).status).toBe(404);
    expect((await app.call("GET", "/api/rules/999/cases")).status).toBe(404);
  });
});
