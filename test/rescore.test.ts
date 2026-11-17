import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleAnalytics } from "../src/analytics.ts";
import type { Matcher } from "../src/matcher.ts";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import type { RescoreResult } from "../src/rescore.ts";
import type { RuleDetail } from "../src/rules.ts";
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
 * A live message rule whose old condition fired on two messages, one flagged
 * a wrong match and one correct, and a draft with new conditions.
 */
async function ruleWithCases(running: RunningApp, draftConditions: string[]): Promise<number> {
  const ruleId = sandbox.liveRule({ name: "Local link", conditions: ["Old condition."] });
  const old = standInMatcher({ "Old condition.": 0.8 });
  await message("talks about links in general", old);
  await message("please fix the button colour", old);
  const { recentFirings } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
  const firingOn = (text: string) => recentFirings.find((f) => f.text === text)!.firingId;
  await running.json("POST", `/api/firings/${firingOn("talks about links in general")}/flag`, { verdict: "wrong" });
  await running.json("POST", `/api/firings/${firingOn("please fix the button colour")}/flag`, { verdict: "correct" });
  await running.json("PUT", `/api/rules/${ruleId}/draft`, {
    instruction: "Give a local link.",
    conditions: draftConditions,
  });
  return ruleId;
}

const rescore = (running: RunningApp, ruleId: number) =>
  running.json<RescoreResult>("POST", `/api/rules/${ruleId}/rescore`, {});

const checkCount = () => sandbox.query<{ n: number }>("SELECT COUNT(*) AS n FROM checks")[0]!.n;

describe("re-scoring a draft against its saved cases before publishing", () => {
  it("scores the draft's conditions against each case and shows which pass", async () => {
    const jev = byText({
      "talks about links in general": { "Asks for a visual change.": 0.2, "Mentions a page.": 0.3 },
      "please fix the button colour": { "Asks for a visual change.": 0.9, "Mentions a page.": 0.1 },
    });
    const running = await appWith(jev);
    const ruleId = await ruleWithCases(running, ["Asks for a visual change.", "Mentions a page."]);

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({
      status: "scored",
      cutoff: 0.6,
      passed: 2,
      failed: 0,
      cases: expect.arrayContaining([
        {
          case: expect.objectContaining({ text: "talks about links in general", expected: "should_not_fire" }),
          scores: [
            { condition: "Asks for a visual change.", score: 0.2 },
            { condition: "Mentions a page.", score: 0.3 },
          ],
          best: 0.3,
          fired: false,
          passed: true,
        },
        {
          case: expect.objectContaining({ text: "please fix the button colour", expected: "should_fire" }),
          scores: [
            { condition: "Asks for a visual change.", score: 0.9 },
            { condition: "Mentions a page.", score: 0.1 },
          ],
          best: 0.9,
          fired: true,
          passed: true,
        },
      ]),
    });
    // One request per case, carrying only the draft's conditions, never the instruction or the old condition.
    expect(jev.calls.map((c) => c.text).sort()).toEqual(["please fix the button colour", "talks about links in general"]);
    for (const call of jev.calls) {
      expect(call.conditions.map((c) => c.text)).toEqual(["Asks for a visual change.", "Mentions a page."]);
    }
  });

  it("fails a case the draft would still match wrongly, and one it no longer matches", async () => {
    const running = await appWith(
      byText({
        "talks about links in general": { "Mentions links.": 0.7 },
        "please fix the button colour": { "Mentions links.": 0.59 },
      }),
    );
    const ruleId = await ruleWithCases(running, ["Mentions links."]);

    const result = await rescore(running, ruleId);

    expect(result.status).toBe("scored");
    if (result.status !== "scored") return;
    expect(result).toMatchObject({ passed: 0, failed: 2 });
    expect(result.cases.map((c) => [c.case.text, c.fired, c.passed]).sort()).toEqual([
      ["please fix the button colour", false, false],
      ["talks about links in general", true, false],
    ]);
  });

  it("judges at the cutoff in force", async () => {
    const running = await appWith(byText({ "please fix the button colour": { "Mentions links.": 0.5 } }));
    const ruleId = await ruleWithCases(running, ["Mentions links."]);
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.5 }));

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({ status: "scored", cutoff: 0.5, passed: 2, failed: 0 });
  });

  it("changes nothing and records no check, and the user can still publish or go back to the draft", async () => {
    const running = await appWith(byText({}));
    const ruleId = await ruleWithCases(running, ["Mentions links."]);
    const before = checkCount();

    await rescore(running, ruleId);

    expect(checkCount()).toBe(before);
    const rule = await running.json<RuleDetail>("GET", `/api/rules/${ruleId}`);
    expect(rule).toMatchObject({ live: { number: 1, conditions: ["Old condition."] }, draft: { conditions: ["Mentions links."] } });
    // Going back to the draft: it is still there to edit.
    await running.json("PUT", `/api/rules/${ruleId}/draft`, { instruction: "Give a local link.", conditions: ["Better."] });
    // Publishing anyway.
    const published = await running.json<{ versionNumber: number }>("POST", `/api/rules/${ruleId}/publish`, {});
    expect(published.versionNumber).toBe(2);
  });

  it("works for reply-check rules too", async () => {
    const running = await appWith(byText({ "Done, the page is updated.": { "Reports a visual change with no link.": 0.95 } }));
    const ruleId = sandbox.liveRule({ name: "Link on handover", checkType: "reply", conditions: ["Old condition."] });
    await reply("Done, the page is updated.", standInMatcher({ "Old condition.": 0.8 }));
    const { recentFirings } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    await running.json("POST", `/api/firings/${recentFirings[0]!.firingId}/flag`, { verdict: "correct" });
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Give a local link.",
      conditions: ["Reports a visual change with no link."],
    });

    const result = await rescore(running, ruleId);

    expect(result).toMatchObject({
      status: "scored",
      passed: 1,
      cases: [{ case: { checkType: "reply", expected: "should_fire" }, fired: true, passed: true }],
    });
  });

  it("masks email addresses in what it sends", async () => {
    const jev = byText({});
    const running = await appWith(jev);
    const ruleId = sandbox.liveRule({ name: "Rule", conditions: ["Old condition."] });
    await message("write to someone@example.com about it", standInMatcher({ "Old condition.": 0.8 }));
    const { recentFirings } = await running.json<RuleAnalytics>("GET", `/api/rules/${ruleId}/analytics`);
    await running.json("POST", `/api/firings/${recentFirings[0]!.firingId}/flag`, { verdict: "wrong" });
    await running.json("PUT", `/api/rules/${ruleId}/draft`, {
      instruction: "Do it.",
      conditions: ["Mentions other@example.com."],
    });

    await rescore(running, ruleId);

    expect(jev.calls).toEqual([
      { text: "write to [email] about it", conditions: [{ id: expect.any(String), text: "Mentions [email]." }] },
    ]);
  });
});

describe("a rule with no saved cases", () => {
  it("asks Jev nothing and publishes as before", async () => {
    const jev = byText({});
    const running = await appWith(jev);
    const ruleId = sandbox.liveRule({ name: "Rule" });
    await running.json("PUT", `/api/rules/${ruleId}/draft`, { instruction: "Do it.", conditions: ["New."] });

    expect(await rescore(running, ruleId)).toEqual({ status: "no_cases", cutoff: 0.6 });
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
    const ruleId = await ruleWithCases(running, ["Mentions links."]);

    expect(await rescore(running, ruleId)).toEqual({
      status: "failed",
      cutoff: 0.6,
      error: "Jev returned HTTP 503",
      caseCount: 2,
    });
    expect(await running.json("POST", `/api/rules/${ruleId}/publish`, {})).toMatchObject({ versionNumber: 2 });
  });

  it("covers a missing API key and a malformed answer", async () => {
    const noKey = await appWith(undefined);
    const ruleId = await ruleWithCases(noKey, ["Mentions links."]);
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
