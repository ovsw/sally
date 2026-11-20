import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleAnalytics } from "../src/analytics.ts";
import type { Matcher } from "../src/matcher.ts";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import type { RescoreResult } from "../src/rescore.ts";
import { conditionsFor, type RuleDetail } from "../src/rules.ts";
import { type RunningApp, startApp } from "./support/app.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { type StandIn, standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
let app: RunningApp | undefined;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  sandbox.cleanup();
});

/** Starts the app with this matcher standing in for Jev during re-scoring. */
async function appWith(matcher?: Matcher): Promise<RunningApp> {
  app = await startApp(sandbox, { matcher });
  return app;
}

const message = (prompt: string, matcher: StandIn) =>
  runMessageHook(hookInput(prompt), { env: sandbox.env, matcher });

const reply = (text: string, matcher: StandIn) =>
  runReplyHook(
    JSON.stringify({
      session_id: "session-1",
      transcript_path: join(sandbox.root, "missing.jsonl"),
      cwd: "/work/project",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: text,
    }),
    { env: sandbox.env, matcher },
  );

/**
 * A stand-in that scores each condition by the text being checked:
 * `scores[text][condition]`, 0 when absent.
 */
const byText = (scores: Record<string, Record<string, number>>) =>
  standInMatcher({}, {
    answer: async (conditions, _signal, text) => ({
      scores: Object.fromEntries(conditions.map((c) => [c.id, scores[text]?.[c.text] ?? 0])),
      inputTokens: 42,
    }),
  });

/**
 * A live message rule whose old condition matched on two messages, both
 * marked as false positives, and a draft with new conditions.
 */
async function ruleWithFalsePositives(running: RunningApp, draftConditions: string[]): Promise<number> {
  const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Old condition."] });
  const old = standInMatcher({ "Old condition.": 0.8 });
  await message("talks about links in general", old);
  await message("please fix the button colour", old);
  const { recentMatches } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
  const matchOn = (text: string) => recentMatches.find((f) => f.text === text)!.matchId;
  await running.json("POST", `/api/matches/${matchOn("talks about links in general")}/false-positive`, {});
  await running.json("POST", `/api/matches/${matchOn("please fix the button colour")}/false-positive`, {});
  await running.json("PUT", `/api/rules/${ruleId}/draft`, {
    instruction: "Give a local link.",
    conditions: conditionsFor("message", draftConditions),
  });
  return ruleId;
}

const rescore = (running: RunningApp, ruleId: number) =>
  running.json<RescoreResult>("POST", `/api/rules/${ruleId}/rescore`, {});

const checkCount = () => sandbox.query<{ n: number }>("SELECT COUNT(*) AS n FROM checks")[0]!.n;

describe("re-scoring a draft against its false positives before publishing", () => {
  it("scores the draft's conditions against each false positive and shows which it no longer matches", async () => {
    const jev = byText({
      "talks about links in general": { "Asks for a visual change.": 0.2, "Mentions a page.": 0.3 },
      "please fix the button colour": { "Asks for a visual change.": 0.5, "Mentions a page.": 0.1 },
    });
    const running = await appWith(jev);
    const ruleId = await ruleWithFalsePositives(running, ["Asks for a visual change.", "Mentions a page."]);

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({
      status: "scored",
      cutoffs: { message: 0.6, reply: 0.6 },
      passed: 2,
      failed: 0,
      results: expect.arrayContaining([
        {
          falsePositive: expect.objectContaining({ text: "talks about links in general", markedBy: "user" }),
          scores: [
            { condition: "Asks for a visual change.", score: 0.2 },
            { condition: "Mentions a page.", score: 0.3 },
          ],
          best: 0.3,
          cutoff: 0.6,
          matched: false,
          passed: true,
        },
        {
          falsePositive: expect.objectContaining({ text: "please fix the button colour", markedBy: "user" }),
          scores: [
            { condition: "Asks for a visual change.", score: 0.5 },
            { condition: "Mentions a page.", score: 0.1 },
          ],
          best: 0.5,
          cutoff: 0.6,
          matched: false,
          passed: true,
        },
      ]),
    });
    // One request per false positive, carrying only the draft's conditions, never the instruction or the old condition.
    expect(jev.calls.map((c) => c.text).sort()).toEqual(["please fix the button colour", "talks about links in general"]);
    for (const call of jev.calls) {
      expect(call.conditions.map((c) => c.text)).toEqual(["Asks for a visual change.", "Mentions a page."]);
    }
  });

  it("fails a false positive the draft would still match, and passes one it no longer matches", async () => {
    const running = await appWith(
      byText({
        "talks about links in general": { "Mentions links.": 0.7 },
        "please fix the button colour": { "Mentions links.": 0.59 },
      }),
    );
    const ruleId = await ruleWithFalsePositives(running, ["Mentions links."]);

    const result = await rescore(running, ruleId);

    expect(result.status).toBe("scored");
    if (result.status !== "scored") return;
    expect(result).toMatchObject({ passed: 1, failed: 1 });
    expect(result.results.map((r) => [r.falsePositive.text, r.matched, r.passed]).sort()).toEqual([
      ["please fix the button colour", false, true],
      ["talks about links in general", true, false],
    ]);
  });

  it("judges at the cutoff in force", async () => {
    const running = await appWith(byText({ "please fix the button colour": { "Mentions links.": 0.5 } }));
    const ruleId = await ruleWithFalsePositives(running, ["Mentions links."]);
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.5 }));

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({ status: "scored", cutoffs: { message: 0.5 }, passed: 1, failed: 1 });
  });

  it("changes nothing and records no check, and the user can still publish or go back to the draft", async () => {
    const running = await appWith(byText({}));
    const ruleId = await ruleWithFalsePositives(running, ["Mentions links."]);
    const before = checkCount();

    await rescore(running, ruleId);

    expect(checkCount()).toBe(before);
    const rule = await running.json<RuleDetail>("GET", `/api/rules/${ruleId}`);
    expect(rule).toMatchObject({ live: { number: 1, conditions: [{ text: "Old condition." }] }, draft: { conditions: [{ text: "Mentions links." }] } });
    // Going back to the draft: it is still there to edit.
    await running.json("PUT", `/api/rules/${ruleId}/draft`, { instruction: "Give a local link.", conditions: conditionsFor("message", ["Better."]) });
    // Publishing anyway.
    const published = await running.json<{ versionNumber: number }>("POST", `/api/rules/${ruleId}/publish`, {});
    expect(published.versionNumber).toBe(2);
  });

  it("works for reply-check rules too", async () => {
    const running = await appWith(byText({ "Done, the page is updated.": { "Reports a visual change with no link.": 0.95 } }));
    const ruleId = sandbox.liveRule({ name: "Link on handover", checkType: "reply", conditions: ["Old condition."] });
    await reply("Done, the page is updated.", standInMatcher({ "Old condition.": 0.8 }));
    const { recentMatches } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    await running.json("POST", `/api/matches/${recentMatches[0]!.matchId}/false-positive`, {});
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      conditions: conditionsFor("reply", ["Reports a visual change with no link."]),
    });

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({
      status: "scored",
      failed: 1,
      results: [{ falsePositive: { checkType: "reply", text: "Done, the page is updated." }, matched: true, passed: false }],
    });
  });

  it("judges a reply at the reply cutoff", async () => {
    const running = await appWith(byText({ "Done, the page is updated.": { "Reports a visual change with no link.": 0.7 } }));
    const ruleId = sandbox.liveRule({ name: "Link on handover", checkType: "reply", conditions: ["Old condition."] });
    await reply("Done, the page is updated.", standInMatcher({ "Old condition.": 0.8 }));
    const { recentMatches } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    await running.json("POST", `/api/matches/${recentMatches[0]!.matchId}/false-positive`, {});
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      conditions: conditionsFor("reply", ["Reports a visual change with no link."]),
    });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.5, replyCutoff: 0.8 }));

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({
      status: "scored",
      cutoffs: { message: 0.5, reply: 0.8 },
      passed: 1,
      results: [{ best: 0.7, cutoff: 0.8, matched: false, passed: true }],
    });
  });

  it("masks email addresses in what it sends", async () => {
    const jev = byText({});
    const running = await appWith(jev);
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Old condition."] });
    await message("write to someone@example.com about it", standInMatcher({ "Old condition.": 0.8 }));
    const { recentMatches } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    await running.json("POST", `/api/matches/${recentMatches[0]!.matchId}/false-positive`, {});
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Do it.",
      conditions: conditionsFor("message", ["Mentions other@example.com."]),
    });

    await rescore(running, ruleId);

    expect(jev.calls).toEqual([
      { text: "write to [email] about it", conditions: [{ id: expect.any(String), text: "Mentions [email]." }] },
    ]);
  });
});

describe("re-scoring a rule that is in both checks", () => {
  /**
   * A live rule with one Message and one Reply condition, which matched on a
   * message and on a reply, both marked as false positives.
   */
  async function ruleInBothChecks(running: RunningApp): Promise<number> {
    const ruleId = sandbox.liveRule({
      name: "Local link",
      conditions: [
        { text: "Old message condition.", message: true, reply: false },
        { text: "Old reply condition.", message: false, reply: true },
      ],
    });
    const old = standInMatcher({ "Old message condition.": 0.9, "Old reply condition.": 0.9 });
    await message("please fix the button colour", old);
    await reply("Done, the page is updated.", old);
    const { recentMatches } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    expect(recentMatches).toHaveLength(2);
    for (const match of recentMatches) {
      await running.json("POST", `/api/matches/${match.matchId}/false-positive`, {});
    }
    return ruleId;
  }

  it("scores each false positive only against the draft's conditions for its check type, at that check's cutoff", async () => {
    const jev = byText({
      "please fix the button colour": { "Asks for a visual change.": 0.7, "Reports a visual change.": 0.99 },
      "Done, the page is updated.": { "Asks for a visual change.": 0.99, "Reports a visual change.": 0.7 },
    });
    const running = await appWith(jev);
    const ruleId = await ruleInBothChecks(running);
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      conditions: [
        { text: "Asks for a visual change.", message: true, reply: false },
        { text: "Reports a visual change.", message: false, reply: true },
      ],
    });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.6, replyCutoff: 0.8 }));

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({ status: "scored", cutoffs: { message: 0.6, reply: 0.8 }, passed: 1, failed: 1 });
    if (result.status !== "scored") return;
    const byCheck = Object.fromEntries(result.results.map((r) => [r.falsePositive.checkType, r]));
    expect(byCheck.message).toMatchObject({
      scores: [{ condition: "Asks for a visual change.", score: 0.7 }],
      best: 0.7,
      cutoff: 0.6,
      matched: true,
      passed: false,
    });
    expect(byCheck.reply).toMatchObject({
      scores: [{ condition: "Reports a visual change.", score: 0.7 }],
      best: 0.7,
      cutoff: 0.8,
      matched: false,
      passed: true,
    });
    // Each request carries only the conditions for that false positive's check type.
    expect(Object.fromEntries(jev.calls.map((c) => [c.text, c.conditions.map((x) => x.text)]))).toEqual({
      "please fix the button colour": ["Asks for a visual change."],
      "Done, the page is updated.": ["Reports a visual change."],
    });
  });

  it("uses a condition on for both checks in both, and keeps a published condition's switches", async () => {
    const jev = byText({
      "please fix the button colour": { "Old message condition.": 0.9, "Talks about a page.": 0.1 },
      "Done, the page is updated.": { "Talks about a page.": 0.9 },
    });
    const running = await appWith(jev);
    const ruleId = await ruleInBothChecks(running);
    const live = (await running.json<RuleDetail>("GET", `/api/rules/${ruleId}`)).live!;
    const kept = live.conditions.find((c) => c.text === "Old message condition.")!;
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      // The kept condition says reply: true here, but a published condition keeps its own switches.
      conditions: [{ id: kept.id, text: kept.text, message: true, reply: true }, { text: "Talks about a page.", message: true, reply: true }],
    });

    const result = await rescore(running, ruleId);

    expect(Object.fromEntries(jev.calls.map((c) => [c.text, c.conditions.map((x) => x.text)]))).toEqual({
      "please fix the button colour": ["Old message condition.", "Talks about a page."],
      "Done, the page is updated.": ["Talks about a page."],
    });
    expect(result).toMatchObject({ status: "scored", passed: 0, failed: 2 });
  });

  it("does not match a false positive whose check type no draft condition is on for, and asks Jev nothing for it", async () => {
    const jev = byText({ "please fix the button colour": { "Asks for a visual change.": 0.9 } });
    const running = await appWith(jev);
    const ruleId = await ruleInBothChecks(running);
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      conditions: conditionsFor("message", ["Asks for a visual change."]),
    });

    const result = await rescore(running, ruleId);

    expect(jev.calls.map((c) => c.text)).toEqual(["please fix the button colour"]);
    if (result.status !== "scored") throw new Error(`expected scored, got ${result.status}`);
    expect(result).toMatchObject({ passed: 1, failed: 1 });
    expect(result.results.find((r) => r.falsePositive.checkType === "reply")).toMatchObject({
      scores: [],
      best: null,
      cutoff: 0.6,
      matched: false,
      passed: true,
    });
  });
});

describe("a rule with no false positives", () => {
  it("asks Jev nothing and publishes as before", async () => {
    const jev = byText({});
    const running = await appWith(jev);
    const ruleId = sandbox.liveRule({ name: "Rule" });
    await running.json("PUT", `/api/rules/${ruleId}/draft`, { instruction: "Do it.", conditions: conditionsFor("message", ["New."]) });

    expect(await rescore(running, ruleId)).toEqual({ status: "no_false_positives", cutoffs: { message: 0.6, reply: 0.6 } });
    expect(jev.calls).toEqual([]);
    expect(await running.json("POST", `/api/rules/${ruleId}/publish`, {})).toMatchObject({ versionNumber: 2 });
  });
});

describe("a Jev failure during re-scoring", () => {
  it("is shown as the result and does not block publishing", async () => {
    const running = await appWith(
      standInMatcher({}, {
        answer: async () => {
          throw new Error("Jev returned HTTP 503");
        },
      }),
    );
    const ruleId = await ruleWithFalsePositives(running, ["Mentions links."]);

    expect(await rescore(running, ruleId)).toEqual({
      status: "failed",
      cutoffs: { message: 0.6, reply: 0.6 },
      error: "Jev returned HTTP 503",
      count: 2,
    });
    expect(await running.json("POST", `/api/rules/${ruleId}/publish`, {})).toMatchObject({ versionNumber: 2 });
  });

  it("covers a missing API key and a malformed answer", async () => {
    const noKey = await appWith(undefined);
    const ruleId = await ruleWithFalsePositives(noKey, ["Mentions links."]);
    expect(await rescore(noKey, ruleId)).toMatchObject({ status: "failed", error: "missing API key" });
    await noKey.close();

    const malformed = await appWith(
      standInMatcher({}, { answer: async () => ({ scores: { c0: 1.5 }, inputTokens: null }) }),
    );
    expect(await rescore(malformed, ruleId)).toMatchObject({ status: "failed", error: "malformed answer: no valid score for c0" });
  });
});

describe("refusals", () => {
  it("refuses a rule with no draft, an unfinished draft and an unknown rule", async () => {
    const running = await appWith(byText({}));
    const ruleId = sandbox.liveRule({ name: "Rule" });

    const noDraft = await running.call("POST", `/api/rules/${ruleId}/rescore`, {});
    expect(noDraft.status).toBe(400);
    expect(await noDraft.json()).toEqual({ error: "This rule has no draft to publish." });

    await running.json("PUT", `/api/rules/${ruleId}/draft`, { instruction: "Do it.", conditions: [] });
    const unfinished = await running.call("POST", `/api/rules/${ruleId}/rescore`, {});
    expect(unfinished.status).toBe(400);
    expect(await unfinished.json()).toEqual({ error: "A rule needs at least one condition." });

    expect((await running.call("POST", "/api/rules/999/rescore", {})).status).toBe(404);
  });
});
