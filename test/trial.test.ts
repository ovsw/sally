import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Matcher } from "../src/matcher.ts";
import type { TrialResult } from "../src/trial.ts";
import { type RunningApp, startApp } from "./support/app.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

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

/** Starts the app with this matcher standing in for Jev; without one there is no API key. */
async function appWith(matcher?: Matcher): Promise<RunningApp> {
  app = await startApp(sandbox, { matcher });
  return app;
}

const trial = (running: RunningApp, body: unknown) => running.json<TrialResult>("POST", "/api/trial", body);

const count = (table: string) => sandbox.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;

describe("a trial: typed text scored against typed conditions", () => {
  it("scores each condition and says whether a rule with them would match at the message cutoff", async () => {
    const running = await appWith(
      standInMatcher({ "The message asks for a visual change.": 0.82, "The message mentions a page.": 0.3 }),
    );

    const result = await trial(running, {
      text: "make the button bigger",
      checkType: "message",
      conditions: ["The message asks for a visual change.", "The message mentions a page."],
    });

    expect(result).toEqual({
      status: "scored",
      cutoff: 0.6,
      scores: [
        { condition: "The message asks for a visual change.", score: 0.82 },
        { condition: "The message mentions a page.", score: 0.3 },
      ],
      best: 0.82,
      matched: true,
      cut: false,
    });
  });

  it("uses the reply cutoff for a reply", async () => {
    const running = await appWith(standInMatcher({ "The reply gives steps to do by hand.": 0.7 }));
    await running.json("PUT", "/api/settings", { replyCutoff: 0.8 });

    const result = await trial(running, {
      text: "Open the settings page and click Save.",
      checkType: "reply",
      conditions: ["The reply gives steps to do by hand."],
    });

    expect(result).toMatchObject({ status: "scored", cutoff: 0.8, best: 0.7, matched: false });
  });

  it("leaves out blank conditions and keeps the order of the rest", async () => {
    const jev = standInMatcher({ First: 0.1, Second: 0.2 });
    const running = await appWith(jev);

    const result = await trial(running, { text: "some text", checkType: "message", conditions: [" First ", "  ", "Second"] });

    expect(result).toMatchObject({ scores: [{ condition: "First" }, { condition: "Second" }] });
    expect(jev.calls.flatMap((c) => c.conditions.map((q) => q.text))).toEqual(["First", "Second"]);
  });

  it("records nothing", async () => {
    const running = await appWith(standInMatcher({ Condition: 0.9 }));

    await trial(running, { text: "some text", checkType: "message", conditions: ["Condition"] });

    expect(count("checks")).toBe(0);
    expect(count("scores")).toBe(0);
    expect(count("matches")).toBe(0);
    expect(count("rules")).toBe(0);
  });

  it("masks email addresses in what goes to Jev", async () => {
    const jev = standInMatcher();
    const running = await appWith(jev);

    await trial(running, {
      text: "write to someone@example.com",
      checkType: "message",
      conditions: ["The message names other@example.com."],
    });

    expect(jev.calls[0]!.text).not.toContain("someone@example.com");
    expect(jev.calls[0]!.conditions[0]!.text).not.toContain("other@example.com");
  });

  it("cuts a text too long for Jev in the middle, as a check does, and says so", async () => {
    const jev = standInMatcher();
    const running = await appWith(jev);
    const text = `START ${"filler ".repeat(20_000)} END`;

    const result = await trial(running, { text, checkType: "message", conditions: ["Condition"] });

    expect(result).toMatchObject({ status: "scored", cut: true });
    const sent = jev.calls[0]!.text;
    expect(sent.length).toBeLessThan(text.length);
    expect(sent.startsWith("START")).toBe(true);
    expect(sent.endsWith("END")).toBe(true);
  });

  it("answers a missing API key as a failed trial", async () => {
    const running = await appWith(undefined);

    const result = await trial(running, { text: "some text", checkType: "message", conditions: ["Condition"] });

    expect(result).toEqual({ status: "failed", cutoff: 0.6, error: "missing API key" });
  });

  it("answers a Jev failure as a failed trial, with the reason", async () => {
    const running = await appWith(
      standInMatcher({}, { answer: () => Promise.reject(new Error("Jev returned HTTP 503")) }),
    );

    const result = await trial(running, { text: "some text", checkType: "message", conditions: ["Condition"] });

    expect(result).toEqual({ status: "failed", cutoff: 0.6, error: "Jev returned HTTP 503" });
  });

  it("refuses a blank text, no conditions, a condition too long for Jev, or an unknown check type", async () => {
    const running = await appWith(standInMatcher());
    const status = async (body: unknown) => (await running.call("POST", "/api/trial", body)).status;

    expect(await status({ text: "  ", checkType: "message", conditions: ["Condition"] })).toBe(400);
    expect(await status({ text: "some text", checkType: "message", conditions: ["", " "] })).toBe(400);
    expect(await status({ text: "some text", checkType: "message", conditions: ["word ".repeat(40_000)] })).toBe(400);
    expect(await status({ text: "some text", checkType: "both", conditions: ["Condition"] })).toBe(400);
    expect(await status({ text: "some text", checkType: "message", conditions: "Condition" })).toBe(400);
  });

  it("refuses a condition that fits as written but not once its email addresses are masked", async () => {
    const running = await appWith(standInMatcher());

    const response = await running.call("POST", "/api/trial", {
      text: "some text",
      checkType: "message",
      conditions: ["a@b.co ".repeat(13_265)],
    });

    expect(response.status).toBe(400);
  });
});
