import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REQUEST_TOKEN_LIMIT } from "../src/limits.ts";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import type { LimitUse, Settings } from "../src/rules.ts";
import { type RunningApp, startApp } from "./support/app.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  sandbox.cleanup();
});

interface CheckRow {
  text: string;
  outcome: string;
  cut: number;
  input_tokens: number | null;
  request_tokens: number | null;
}

const checks = () =>
  sandbox.query<CheckRow>("SELECT text, outcome, cut, input_tokens, request_tokens FROM checks ORDER BY id");
const context = (output: string): string => (output ? JSON.parse(output).hookSpecificOutput.additionalContext : "");

/** A condition long enough that a few hundred of them cannot share one request. */
const longCondition = (n: number) => `Condition ${n}: the message${" talks about the layout of the page".repeat(16)}.`;

describe("splitting the conditions across requests", () => {
  it("sends every condition once, across parallel requests with the same text, and combines the scores", async () => {
    const conditions = Array.from({ length: 400 }, (_, n) => longCondition(n));
    sandbox.liveRule({ name: "Many conditions", conditions });
    sandbox.liveRule({ name: "Late rule", conditions: ["The message asks for the very last thing."] });
    const matcher = standInMatcher({ "The message asks for the very last thing.": 0.9 });

    const output = await runMessageHook(hookInput("Tidy up the sidebar"), { env: sandbox.env, matcher });

    expect(matcher.calls.length).toBeGreaterThan(1);
    expect(new Set(matcher.calls.map((call) => call.text))).toEqual(new Set(["Tidy up the sidebar"]));
    const sent = matcher.calls.flatMap((call) => call.conditions.map((c) => c.text));
    expect(sent).toHaveLength(401);
    expect(new Set(sent)).toEqual(new Set([...conditions, "The message asks for the very last thing."]));
    // The rule whose condition went in a later request still matches.
    expect(matcher.calls[0]!.conditions.map((c) => c.text)).not.toContain("The message asks for the very last thing.");
    expect(context(output)).toContain("Late rule");
    expect(sandbox.query("SELECT score FROM scores")).toHaveLength(401);
  });

  it("records the total input tokens and those of the largest request", async () => {
    sandbox.liveRule({ name: "Many conditions", conditions: Array.from({ length: 400 }, (_, n) => longCondition(n)) });
    const matcher = standInMatcher(
      {},
      {
        answer: async (conditions) => ({
          scores: Object.fromEntries(conditions.map((c) => [c.id, 0])),
          inputTokens: conditions.length * 100,
        }),
      },
    );

    await runMessageHook(hookInput("Tidy up the sidebar"), { env: sandbox.env, matcher });

    const sizes = matcher.calls.map((call) => call.conditions.length * 100);
    expect(checks()).toMatchObject([
      { outcome: "nothing", input_tokens: 40_000, request_tokens: Math.max(...sizes) },
    ]);
  });

  it("keeps a check that fits in one request to one request", async () => {
    sandbox.liveRule({ name: "One", conditions: ["Condition A.", "Condition B."] });
    sandbox.liveRule({ name: "Two", conditions: ["Condition C."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(matcher.calls).toHaveLength(1);
    expect(matcher.calls[0]!.conditions).toHaveLength(3);
    expect(checks()).toMatchObject([{ input_tokens: 42, request_tokens: 42 }]);
  });

  it("lets the message through untouched when any one of the requests fails", async () => {
    sandbox.liveRule({ name: "Many conditions", conditions: Array.from({ length: 400 }, (_, n) => longCondition(n)) });
    let call = 0;
    const matcher = standInMatcher(
      {},
      {
        answer: async (conditions) => {
          if (++call === 2) throw new Error("Jev returned HTTP 500");
          return { scores: Object.fromEntries(conditions.map((c) => [c.id, 1])), inputTokens: 10 };
        },
      },
    );

    const output = await runMessageHook(hookInput("Tidy up the sidebar"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(checks()).toMatchObject([{ outcome: "failed" }]);
    expect(sandbox.query("SELECT * FROM matches")).toEqual([]);
  });
});

describe("cutting a long text", () => {
  const longMessage = `START OF MESSAGE ${"word ".repeat(60_000)}END OF MESSAGE`;

  it("cuts a message too long for one question to its last part and records the cut", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput(longMessage), { env: sandbox.env, matcher });

    const sent = matcher.calls[0]!.text;
    expect(sent.length).toBeLessThan(longMessage.length);
    expect(sent.endsWith("word END OF MESSAGE")).toBe(true);
    expect(sent).not.toContain("START OF MESSAGE");
    expect(checks()).toMatchObject([{ text: sent, cut: 1 }]);
  });

  it("leaves more of the text when the longest condition is shorter", async () => {
    sandbox.liveRule({ name: "Short", conditions: ["Condition A."] });
    const short = standInMatcher();
    await runMessageHook(hookInput(longMessage), { env: sandbox.env, matcher: short });

    sandbox.liveRule({ name: "Long", conditions: [longCondition(1)] });
    const long = standInMatcher();
    await runMessageHook(hookInput(longMessage), { env: sandbox.env, matcher: long });

    expect(long.calls[0]!.text.length).toBeLessThan(short.calls[0]!.text.length);
  });

  it("does not cut a text that fits", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });

    expect(matcher.calls[0]!.text).toBe("Make the header smaller");
    expect(checks()).toMatchObject([{ text: "Make the header smaller", cut: 0 }]);
  });

  it("cuts a long reply the same way and records the cut", async () => {
    sandbox.liveRule({ name: "Reply rule", checkType: "reply", conditions: ["The reply is unfinished."] });
    const matcher = standInMatcher();
    const stop = JSON.stringify({
      session_id: "session-1",
      cwd: "/work/project",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: longMessage,
    });

    await runReplyHook(stop, { env: sandbox.env, matcher });

    expect(matcher.calls[0]!.text.endsWith("word END OF MESSAGE")).toBe(true);
    expect(checks()).toMatchObject([{ cut: 1 }]);
  });
});

describe("settings in the app", () => {
  let app: RunningApp;
  beforeEach(async () => {
    app = await startApp(sandbox);
  });
  afterEach(async () => {
    await app.close();
  });

  type SettingsAnswer = { settings: Settings; limitUse: LimitUse };
  const put = (body: unknown) => app.json<SettingsAnswer>("PUT", "/api/settings", body);

  it("gives the settings with their defaults", async () => {
    const { settings } = await app.json<SettingsAnswer>("GET", "/api/settings");
    expect(settings).toEqual({
      cutoff: 0.6,
      timeLimitMs: 10_000,
      recentChecks: 100,
      busyShare: 0.3,
      closeMargin: 0.05,
      quietChecks: 200,
    });
  });

  it("applies a changed cutoff on the next check", async () => {
    sandbox.liveRule({ name: "First", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Second", conditions: ["Condition B."] });
    const matcher = standInMatcher({ "Condition A.": 0.8, "Condition B.": 0.7 });
    const check = async () => context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect((await put({ cutoff: 0.9 })).settings.cutoff).toBe(0.9);
    expect(await check()).toBe("");

    await put({ cutoff: 0.75 });
    const attached = await check();
    expect(attached).toContain("First");
    expect(attached).not.toContain("Second");
    expect(sandbox.query("SELECT cutoff FROM checks ORDER BY id")).toEqual([{ cutoff: 0.9 }, { cutoff: 0.75 }]);
  });

  it("stores the attention thresholds", async () => {
    await put({ recentChecks: 50, busyShare: 0.4, closeMargin: 0.1, quietChecks: 300 });
    const { settings } = await app.json<SettingsAnswer>("GET", "/api/settings");
    expect(settings).toMatchObject({ recentChecks: 50, busyShare: 0.4, closeMargin: 0.1, quietChecks: 300 });
  });

  it.each([
    [{ cutoff: 2 }, "The cutoff is a score from 0 to 1."],
    [{ timeLimitMs: "4" }, '"timeLimitMs" must be a number.'],
    [{ colour: 1 }, '"colour" is not a setting.'],
  ])("refuses %o and changes nothing", async (body, error) => {
    const response = await app.call("PUT", "/api/settings", { quietChecks: 10, ...body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    const { settings } = await app.json<SettingsAnswer>("GET", "/api/settings");
    expect(settings.quietChecks).toBe(200);
  });

  describe("the share of Jev's request limit in use", () => {
    const checkWithTokens = (inputTokens: number | null) => {
      sandbox.liveRule({ name: `Rule ${Math.random()}`, conditions: ["Condition A."] });
      return runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher: standInMatcher({}, { inputTokens }) });
    };
    const limitUse = async () => (await app.json<SettingsAnswer>("GET", "/api/settings")).limitUse;

    it("is unknown before any check reports tokens", async () => {
      await checkWithTokens(null);
      expect(await limitUse()).toEqual({
        requestLimit: REQUEST_TOKEN_LIMIT,
        warningShare: 0.8,
        checks: 0,
        largestRequest: null,
        share: null,
        warning: false,
      });
    });

    it("gives the largest request of the recent checks as a share of the limit, warning from 80%", async () => {
      await checkWithTokens(12_800);
      expect(await limitUse()).toMatchObject({ checks: 1, largestRequest: 12_800, share: 0.2, warning: false });

      await checkWithTokens(51_199);
      expect((await limitUse()).warning).toBe(false);

      await checkWithTokens(51_200);
      expect(await limitUse()).toMatchObject({ checks: 3, largestRequest: 51_200, share: 0.8, warning: true });
    });

    it("counts only the recent checks", async () => {
      await checkWithTokens(60_000);
      await checkWithTokens(1_000);
      await put({ recentChecks: 1 });
      expect(await limitUse()).toMatchObject({ checks: 1, largestRequest: 1_000, warning: false });
    });
  });
});
