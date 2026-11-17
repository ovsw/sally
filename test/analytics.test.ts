import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { RuleNotFoundError } from "../src/rules.ts";
import { gitRepo } from "./support/git.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { type StandIn, standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
let repo: string;
beforeEach(() => {
  sandbox = createSandbox();
  repo = gitRepo(join(sandbox.root, "repo"), { origin: "git@github.com:acme/widgets.git" });
});
afterEach(() => {
  vi.useRealTimers();
  sandbox.cleanup();
});

const message = (prompt: string, matcher: StandIn, extra: Record<string, unknown> = {}) =>
  runMessageHook(hookInput(prompt, { cwd: repo, ...extra }), { env: sandbox.env, matcher });

const reply = (text: string, matcher: StandIn) =>
  runReplyHook(
    JSON.stringify({
      session_id: "session-1",
      transcript_path: join(sandbox.root, "missing.jsonl"),
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: text,
    }),
    { env: sandbox.env, matcher },
  );

describe("activity", () => {
  it("lists recent checks newest first with time, project, check type, text, outcome and what was attached", async () => {
    sandbox.liveRule({ name: "Local link", conditions: ["Asks for a visual change."] });
    sandbox.liveRule({ name: "Handover link", checkType: "reply", conditions: ["Reports a change with no link."] });
    const matcher = standInMatcher({ "Asks for a visual change.": 0.8, "Reports a change with no link.": 0.9 });

    await message("Make the header smaller", matcher);
    await reply("Done, the header is smaller.", matcher);

    const checks = sandbox.withRules((rules) => rules.activity());
    expect(checks).toMatchObject([
      {
        project: "acme/widgets",
        sessionId: "session-1",
        checkType: "reply",
        text: "Done, the header is smaller.",
        outcome: "sent_back",
        error: null,
        inputTokens: 42,
        firings: [{ name: "Handover link", score: 0.9, dropped: false }],
      },
      {
        project: "acme/widgets",
        checkType: "message",
        text: "Make the header smaller",
        outcome: "attached",
        firings: [{ name: "Local link", score: 0.8, dropped: false }],
      },
    ]);
    expect(new Date(checks[0]!.createdAt).getTime()).not.toBeNaN();
    expect(checks[0]!.id).toBeGreaterThan(checks[1]!.id);
  });

  it("shows rules the cap dropped apart from those attached, strongest first", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ cap: 1 }));
    sandbox.liveRule({ name: "Weaker", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    const matcher = standInMatcher({ "Condition A.": 0.7, "Condition B.": 0.95 });

    await message("hello there", matcher);

    const [check] = sandbox.withRules((rules) => rules.activity());
    expect(check!.firings).toMatchObject([
      { name: "Stronger", score: 0.95, dropped: false },
      { name: "Weaker", score: 0.7, dropped: true },
    ]);
  });

  it("shows checks that attached nothing and checks that were skipped", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.2 });

    await message("hello there", matcher);
    await message("/clear", matcher);

    const checks = sandbox.withRules((rules) => rules.activity());
    expect(checks).toMatchObject([
      { outcome: "skipped", firings: [] },
      { outcome: "nothing", firings: [] },
    ]);
  });

  it("shows engine failures and timeouts with their error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const failing = standInMatcher({}, { answer: () => Promise.reject(new Error("Jev answered 500")) });
    const hanging = standInMatcher(
      {},
      {
        answer: (_conditions, signal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      },
    );

    await message("first", failing);
    const pending = message("second", hanging);
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    const checks = sandbox.withRules((rules) => rules.activity());
    expect(checks).toMatchObject([
      { text: "second", outcome: "failed", error: "timeout after 3000 ms", firings: [] },
      { text: "first", outcome: "failed", error: "Jev answered 500", firings: [] },
    ]);
  });

  it("filters by outcome and check type, and limits to the most recent", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Reply rule", checkType: "reply", conditions: ["Condition B."] });
    const matcher = standInMatcher({ "Condition A.": 0.9 });
    const failing = standInMatcher({}, { answer: () => Promise.reject(new Error("boom")) });

    await message("one", matcher);
    await message("two", failing);
    await message("three", matcher);
    await reply("A reply.", matcher);

    sandbox.withRules((rules) => {
      expect(rules.activity({ outcomes: ["failed"] }).map((c) => c.text)).toEqual(["two"]);
      expect(rules.activity({ outcomes: ["failed", "attached"] }).map((c) => c.text)).toEqual(["three", "two", "one"]);
      expect(rules.activity({ checkType: "reply" }).map((c) => c.text)).toEqual(["A reply."]);
      expect(rules.activity({ limit: 2 }).map((c) => c.text)).toEqual(["A reply.", "three"]);
    });
  });
});

describe("rule analytics", () => {
  it("counts how often the rule fired and lists its firings with scores and the highest condition", async () => {
    const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Condition A.", "Condition B."] });
    await message("first message", standInMatcher({ "Condition A.": 0.7, "Condition B.": 0.9 }));
    await message("second message", standInMatcher({ "Condition A.": 0.1 }));
    await message("third message", standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.3 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics).toMatchObject({ checks: 3, firings: 2, dropped: 0 });
    expect(analytics.recentFirings).toMatchObject([
      {
        text: "third message",
        score: 0.8,
        condition: "Condition A.",
        versionNumber: 1,
        project: "acme/widgets",
        cutoff: 0.6,
        dropped: false,
      },
      { text: "first message", score: 0.9, condition: "Condition B.", versionNumber: 1, dropped: false },
    ]);
  });

  it("lists the replies a reply-check rule fired on", async () => {
    const ruleId = sandbox.liveRule({ name: "Handover", checkType: "reply", conditions: ["No link."] });
    await reply("Done, see the page.", standInMatcher({ "No link.": 0.75 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics).toMatchObject({ checks: 1, firings: 1 });
    expect(analytics.recentFirings).toMatchObject([{ text: "Done, see the page.", score: 0.75, condition: "No link." }]);
  });

  it("counts firings the cap dropped apart and marks them", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ cap: 1 }));
    const weaker = sandbox.liveRule({ name: "Weaker", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    await message("hello there", standInMatcher({ "Condition A.": 0.7, "Condition B.": 0.95 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(weaker));
    expect(analytics).toMatchObject({ checks: 1, firings: 0, dropped: 1 });
    expect(analytics.recentFirings).toMatchObject([{ score: 0.7, dropped: true }]);
  });

  it("lists near misses: checks where the rule's best score sat just under the cutoff", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A.", "Condition B."] });
    await message("well under", standInMatcher({ "Condition A.": 0.3 }));
    await message("just under", standInMatcher({ "Condition A.": 0.4, "Condition B.": 0.55 }));
    await message("at the cutoff", standInMatcher({ "Condition A.": 0.6 }));
    await message("at the margin", standInMatcher({ "Condition B.": 0.5 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics.nearMissMargin).toBe(0.1);
    expect(analytics.nearMisses).toMatchObject([
      { text: "at the margin", score: 0.5, condition: "Condition B.", cutoff: 0.6, versionNumber: 1 },
      { text: "just under", score: 0.55, condition: "Condition B.", cutoff: 0.6 },
    ]);
  });

  it("judges a near miss against the cutoff in force for that check", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.8 }));
    await message("under the old cutoff", standInMatcher({ "Condition A.": 0.75 }));
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.6 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics.nearMisses).toMatchObject([{ text: "under the old cutoff", score: 0.75, cutoff: 0.8 }]);
  });

  it("counts a score exactly the margin under the cutoff as a near miss", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.8 }));
    await message("at the margin", standInMatcher({ "Condition A.": 0.7 }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics.nearMisses).toMatchObject([{ text: "at the margin", score: 0.7, cutoff: 0.8 }]);
  });

  it("gives each published version its own firing count, newest first", async () => {
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Old wording."] });
    await message("one", standInMatcher({ "Old wording.": 0.9 }));
    await message("two", standInMatcher({ "Old wording.": 0.2 }));
    sandbox.withRules((rules) => {
      rules.saveDraft(ruleId, { instruction: "Do it.", conditions: ["New wording."] });
      rules.publish(ruleId);
    });
    await message("three", standInMatcher({ "New wording.": 0.9 }));
    await message("four", standInMatcher({ "New wording.": 0.95 }));
    await message("five", standInMatcher({ "New wording.": 0.8 }));
    // A draft is not a version and has no performance.
    sandbox.withRules((rules) => rules.saveDraft(ruleId, { instruction: "Do it.", conditions: ["Newer."] }));

    const analytics = sandbox.withRules((rules) => rules.ruleAnalytics(ruleId));
    expect(analytics.versions).toMatchObject([
      { number: 2, checks: 3, firings: 3 },
      { number: 1, checks: 2, firings: 1 },
    ]);
    expect(analytics).toMatchObject({ checks: 5, firings: 4 });
    expect(analytics.recentFirings.map((f) => f.versionNumber)).toEqual([2, 2, 2, 1]);
  });

  it("is empty for a rule that has never been checked", () => {
    const ruleId = sandbox.withRules((rules) =>
      rules.createRule({ name: "New", checkType: "message", instruction: "Do X.", conditions: ["Condition A."] }),
    ).ruleId;

    expect(sandbox.withRules((rules) => rules.ruleAnalytics(ruleId))).toEqual({
      checks: 0,
      firings: 0,
      dropped: 0,
      wrongMatches: 0,
      recentFirings: [],
      nearMisses: [],
      nearMissMargin: 0.1,
      versions: [],
    });
  });

  it("refuses a rule that does not exist", () => {
    sandbox.withRules((rules) => expect(() => rules.ruleAnalytics(999)).toThrow(RuleNotFoundError));
  });

  it("does not count other rules' checks or firings", async () => {
    const mine = sandbox.liveRule({ name: "Mine", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Other", checkType: "reply", conditions: ["Condition B."] });
    await reply("A reply.", standInMatcher({ "Condition B.": 0.9 }));

    expect(sandbox.withRules((rules) => rules.ruleAnalytics(mine))).toMatchObject({ checks: 0, firings: 0 });
  });
});
