import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MalformedAnswerError } from "../src/matcher.ts";
import { ATTACHED_HEADER, REPORT_LINE, runMessageHook } from "../src/message-hook.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

interface CheckRow {
  id: number;
  created_at: string;
  session_id: string | null;
  cwd: string | null;
  check_type: string;
  text: string;
  duration_ms: number;
  input_tokens: number | null;
  cutoff: number;
  cap: number | null;
  outcome: string;
  error: string | null;
}

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  vi.useRealTimers();
  sandbox.cleanup();
});

const checks = () => sandbox.query<CheckRow>("SELECT * FROM checks ORDER BY id");
const context = (output: string): string => JSON.parse(output).hookSpecificOutput.additionalContext;

describe("message check", () => {
  it("attaches the header, the rule's name and its instruction word for word at the cutoff", async () => {
    const instruction = "Show the change on the local dev server first,\nwith the exact localhost URL.";
    sandbox.liveRule({ name: "Local link first", instruction, conditions: ["The message asks for a visual change."] });
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.6 });

    const output = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });

    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const text = context(output);
    expect(text.startsWith(ATTACHED_HEADER)).toBe(true);
    expect(text).toContain("Local link first");
    expect(text).toContain(instruction);
    expect(checks()[0]!.outcome).toBe("attached");
  });

  it("attaches above the cutoff and lists fired rules strongest first", async () => {
    sandbox.liveRule({ name: "Weaker", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Stronger", conditions: ["Condition B."] });
    const matcher = standInMatcher({ "Condition A.": 0.7, "Condition B.": 0.95 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text.indexOf("Stronger")).toBeLessThan(text.indexOf("Weaker"));
  });

  it("prints nothing below the cutoff and records the check", async () => {
    sandbox.liveRule({ name: "Near", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.59 });

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(checks()).toMatchObject([{ outcome: "nothing", error: null }]);
    expect(sandbox.query("SELECT * FROM firings")).toEqual([]);
  });

  it("prints nothing with no live rules and records it as a failure without calling the matcher", async () => {
    const matcher = standInMatcher();

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(matcher.calls).toEqual([]);
    expect(checks()).toMatchObject([{ outcome: "failed", error: "no live rules" }]);
  });

  it("fires a rule when any one of its conditions clears the cutoff and records each score", async () => {
    const ruleId = sandbox.liveRule({
      name: "Several",
      conditions: ["First condition.", "Second condition.", "Third condition."],
    });
    const matcher = standInMatcher({ "First condition.": 0.1, "Second condition.": 0.8, "Third condition.": 0.3 });

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(context(output)).toContain("Several");
    const scores = sandbox.query<{ text: string; score: number; rule_id: number }>(
      `SELECT c.text, s.score, s.rule_id FROM scores s JOIN conditions c ON c.id = s.condition_id ORDER BY c.position`,
    );
    expect(scores).toEqual([
      { text: "First condition.", score: 0.1, rule_id: ruleId },
      { text: "Second condition.", score: 0.8, rule_id: ruleId },
      { text: "Third condition.", score: 0.3, rule_id: ruleId },
    ]);
    const firings = sandbox.query<{ text: string; score: number }>(
      "SELECT c.text, f.score FROM firings f JOIN conditions c ON c.id = f.condition_id",
    );
    expect(firings).toEqual([{ text: "Second condition.", score: 0.8 }]);
  });

  it("sends the matcher only the message and the conditions, one question per condition", async () => {
    sandbox.liveRule({
      name: "Rule one",
      instruction: "SECRET INSTRUCTION ONE",
      conditions: ["Condition one.", "Condition two."],
    });
    sandbox.liveRule({ name: "Rule two", instruction: "SECRET INSTRUCTION TWO", conditions: ["Condition three."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("The message itself"), { env: sandbox.env, matcher });

    expect(matcher.calls).toHaveLength(1);
    const [call] = matcher.calls;
    expect(call!.text).toBe("The message itself");
    expect(call!.conditions.map((c) => c.text)).toEqual(["Condition one.", "Condition two.", "Condition three."]);
    expect(new Set(call!.conditions.map((c) => c.id)).size).toBe(3);
    expect(JSON.stringify(call)).not.toContain("SECRET INSTRUCTION");
    expect(JSON.stringify(call)).not.toContain("Rule one");
  });

  it("does not send reply-check rules on a message check", async () => {
    sandbox.liveRule({ name: "Reply rule", checkType: "reply", conditions: ["The reply is unfinished."] });
    sandbox.liveRule({ name: "Message rule", conditions: ["The message is a question."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(matcher.calls[0]!.conditions.map((c) => c.text)).toEqual(["The message is a question."]);
  });

  it("ignores answers for IDs that were not sent", async () => {
    sandbox.liveRule({ name: "Only", conditions: ["Condition A."] });
    const matcher = standInMatcher(
      {},
      {
        answer: async (conditions) => ({
          scores: { ...Object.fromEntries(conditions.map((c) => [c.id, 0.1])), unknown: 0.99, c999: 0.99 },
          inputTokens: 10,
        }),
      },
    );

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(checks()).toMatchObject([{ outcome: "nothing" }]);
    expect(sandbox.query("SELECT * FROM scores")).toHaveLength(1);
  });
});

describe("drafts and publishing", () => {
  it("ignores a rule that has only a draft", async () => {
    sandbox.withRules((rules) =>
      rules.createRule({ name: "Draft only", checkType: "message", instruction: "Do X.", conditions: ["Condition A."] }),
    );
    const matcher = standInMatcher({ "Condition A.": 1 });

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(matcher.calls).toEqual([]);
  });

  it("keeps using the live version while a draft is open, and the published draft on the next check", async () => {
    const ruleId = sandbox.liveRule({ name: "Evolving", instruction: "Version one.", conditions: ["Old condition."] });
    sandbox.withRules((rules) =>
      rules.saveDraft(ruleId, { instruction: "Version two.", conditions: ["New condition."] }),
    );
    const matcher = standInMatcher({ "Old condition.": 0.9, "New condition.": 0.9 });

    const before = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));
    expect(before).toContain("Version one.");
    expect(matcher.calls[0]!.conditions.map((c) => c.text)).toEqual(["Old condition."]);

    sandbox.withRules((rules) => rules.publish(ruleId));
    const after = context(await runMessageHook(hookInput("hello again"), { env: sandbox.env, matcher }));
    expect(after).toContain("Version two.");
    expect(after).not.toContain("Version one.");
    expect(matcher.calls[1]!.conditions.map((c) => c.text)).toEqual(["New condition."]);

    const versions = sandbox.query<{ number: number }>(
      `SELECT v.number FROM scores s JOIN versions v ON v.id = s.version_id ORDER BY s.rowid`,
    );
    expect(versions).toEqual([{ number: 1 }, { number: 2 }]);
  });
});

describe("what is recorded", () => {
  it("records the check, every condition's score with its rule version, and each firing", async () => {
    const fired = sandbox.liveRule({ name: "Fires", conditions: ["Condition A.", "Condition B."] });
    const quiet = sandbox.liveRule({ name: "Quiet", conditions: ["Condition C."] });
    const matcher = standInMatcher({ "Condition A.": 0.65, "Condition B.": 0.2, "Condition C.": 0.4 }, { inputTokens: 321 });
    const before = Date.now();

    await runMessageHook(hookInput("The full text of the message", { session_id: "abc-123" }), {
      env: sandbox.env,
      matcher,
    });

    const [check] = checks();
    expect(check).toMatchObject({
      session_id: "abc-123",
      cwd: "/work/project",
      check_type: "message",
      text: "The full text of the message",
      input_tokens: 321,
      cutoff: 0.6,
      cap: 3,
      outcome: "attached",
      error: null,
    });
    expect(Date.parse(check!.created_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(check!.duration_ms).toBeGreaterThanOrEqual(0);

    const scores = sandbox.query<{ rule_id: number; version: number; text: string; score: number }>(
      `SELECT s.rule_id, v.number AS version, c.text, s.score
         FROM scores s JOIN versions v ON v.id = s.version_id JOIN conditions c ON c.id = s.condition_id
        WHERE s.check_id = ? ORDER BY c.text`,
      check!.id,
    );
    expect(scores).toEqual([
      { rule_id: fired, version: 1, text: "Condition A.", score: 0.65 },
      { rule_id: fired, version: 1, text: "Condition B.", score: 0.2 },
      { rule_id: quiet, version: 1, text: "Condition C.", score: 0.4 },
    ]);
    const firings = sandbox.query<{ rule_id: number; version: number; text: string; score: number }>(
      `SELECT f.rule_id, v.number AS version, c.text, f.score
         FROM firings f JOIN versions v ON v.id = f.version_id JOIN conditions c ON c.id = f.condition_id
        WHERE f.check_id = ?`,
      check!.id,
    );
    expect(firings).toEqual([{ rule_id: fired, version: 1, text: "Condition A.", score: 0.65 }]);
  });
});

describe("failing open", () => {
  const fails = async (matcher: ReturnType<typeof standInMatcher>, error: string | RegExp) => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    expect(output).toBe("");
    const [check] = checks();
    expect(check!.outcome).toBe("failed");
    expect(check!.error).toMatch(error);
    expect(sandbox.query("SELECT * FROM firings")).toEqual([]);
  };

  it("gives up after 3 seconds by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    let aborted = false;
    const matcher = standInMatcher(
      {},
      {
        answer: (_conditions, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
      },
    );

    const pending = runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBe("");
    expect(aborted).toBe(true);
    expect(checks()).toMatchObject([{ outcome: "failed", error: "timeout after 3000 ms" }]);
  });

  it("fails open when the matcher errors", async () => {
    await fails(
      standInMatcher({}, { answer: async () => Promise.reject(new Error("Jev returned HTTP 503")) }),
      "Jev returned HTTP 503",
    );
  });

  it("fails open when the matcher's answer is malformed", async () => {
    await fails(
      standInMatcher({}, { answer: async () => Promise.reject(new MalformedAnswerError("response is not JSON")) }),
      /malformed answer/,
    );
  });

  it.each([
    ["a score that is not a number", Number.NaN],
    ["a score above 1", 1.5],
    ["a score below 0", -0.1],
  ])("fails open on %s", async (_label, value) => {
    await fails(
      standInMatcher(
        {},
        { answer: async (conditions) => ({ scores: { [conditions[0]!.id]: value }, inputTokens: 5 }) },
      ),
      /malformed answer/,
    );
  });

  it("fails open when a sent condition gets no answer", async () => {
    await fails(standInMatcher({}, { answer: async () => ({ scores: {}, inputTokens: 5 }) }), /malformed answer/);
  });

  it("fails open with no API key and records the failure", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env });

    expect(output).toBe("");
    expect(checks()).toMatchObject([{ outcome: "failed", error: "missing API key" }]);
  });

  it("prints nothing for input it cannot read", async () => {
    expect(await runMessageHook("not json", { env: sandbox.env, matcher: standInMatcher() })).toBe("");
    expect(await runMessageHook(hookInput("   "), { env: sandbox.env, matcher: standInMatcher() })).toBe("");
  });
});

describe("the cap", () => {
  const firings = () =>
    sandbox.query<{ name: string; score: number; dropped: number }>(
      "SELECT r.name, f.score, f.dropped FROM firings f JOIN rules r ON r.id = f.rule_id ORDER BY f.score DESC",
    );

  it("attaches the 3 strongest rules by default, strongest first, and records the rest as dropped", async () => {
    const scores: Record<string, number> = { A: 0.7, B: 0.95, C: 0.62, D: 0.8, E: 0.9 };
    for (const name of Object.keys(scores)) sandbox.liveRule({ name: `Rule ${name}`, conditions: [`Condition ${name}.`] });
    const matcher = standInMatcher(Object.fromEntries(Object.entries(scores).map(([k, v]) => [`Condition ${k}.`, v])));

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    const attached = ["Rule B", "Rule E", "Rule D"].map((name) => text.indexOf(name));
    expect(attached.every((i) => i >= 0)).toBe(true);
    expect(attached).toEqual([...attached].sort((a, b) => a - b));
    expect(text).not.toContain("Rule A");
    expect(text).not.toContain("Rule C");
    expect(firings()).toEqual([
      { name: "Rule B", score: 0.95, dropped: 0 },
      { name: "Rule E", score: 0.9, dropped: 0 },
      { name: "Rule D", score: 0.8, dropped: 0 },
      { name: "Rule A", score: 0.7, dropped: 1 },
      { name: "Rule C", score: 0.62, dropped: 1 },
    ]);
    expect(checks()).toMatchObject([{ outcome: "attached", cap: 3 }]);
  });

  it("orders a rule by its best condition", async () => {
    sandbox.liveRule({ name: "Two conditions", conditions: ["Weak.", "Strong."] });
    sandbox.liveRule({ name: "One condition", conditions: ["Middle."] });
    sandbox.withRules((rules) => rules.updateSettings({ cap: 1 }));
    const matcher = standInMatcher({ "Weak.": 0.61, "Strong.": 0.99, "Middle.": 0.9 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text).toContain("Two conditions");
    expect(text).not.toContain("One condition");
    expect(firings()).toEqual([
      { name: "Two conditions", score: 0.99, dropped: 0 },
      { name: "One condition", score: 0.9, dropped: 1 },
    ]);
  });
});

describe("stored settings", () => {
  it("reads the cutoff and cap from the stored settings and records them on the check", async () => {
    sandbox.liveRule({ name: "Rule A", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Rule B", conditions: ["Condition B."] });
    sandbox.liveRule({ name: "Rule C", conditions: ["Condition C."] });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.4, cap: 2 }));
    const matcher = standInMatcher({ "Condition A.": 0.45, "Condition B.": 0.5, "Condition C.": 0.39 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text.indexOf("Rule B")).toBeLessThan(text.indexOf("Rule A"));
    expect(text).not.toContain("Rule C");
    expect(checks()).toMatchObject([{ cutoff: 0.4, cap: 2, outcome: "attached" }]);
  });

  it("reads the time limit from the stored settings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    sandbox.withRules((rules) => rules.updateSettings({ timeLimitMs: 500 }));
    const matcher = standInMatcher({}, { answer: () => new Promise(() => {}) });

    const pending = runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    await vi.advanceTimersByTimeAsync(500);

    expect(await pending).toBe("");
    expect(checks()).toMatchObject([{ outcome: "failed", error: "timeout after 500 ms" }]);
  });
});

describe("the attached text", () => {
  it("ends with one line telling Claude how to report a rule that does not apply", async () => {
    sandbox.liveRule({ name: "Rule A", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 0.9 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text.endsWith(`\n\n${REPORT_LINE}`)).toBe(true);
    expect(REPORT_LINE).not.toContain("\n");
  });
});

describe("email masking", () => {
  it("masks email addresses in the message and in conditions before anything is sent", async () => {
    sandbox.liveRule({ name: "Mail", conditions: ["The message mentions boss.person@example.co.uk."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("Write to ana.maria+work@mail.example.com and Bob@Example.ORG, please."), {
      env: sandbox.env,
      matcher,
    });

    const sent = JSON.stringify(matcher.calls);
    expect(sent).not.toMatch(/@/);
    expect(matcher.calls[0]!.text).toBe("Write to [email] and [email], please.");
    expect(matcher.calls[0]!.conditions[0]!.text).toBe("The message mentions [email].");
  });

  it("masks addresses with a quoted local part or an address literal", async () => {
    sandbox.liveRule({ name: "Mail", conditions: ["Condition A."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput('Send to "ana maria"@example.com or ops@[192.0.2.1] today.'), {
      env: sandbox.env,
      matcher,
    });

    expect(matcher.calls[0]!.text).toBe("Send to [email] or [email] today.");
  });

  it("checks a message holding one very long word without stalling", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher();
    const word = "a".repeat(100_000);

    const started = Date.now();
    await runMessageHook(hookInput(`look at ${word} please`), { env: sandbox.env, matcher });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(matcher.calls[0]!.text).toBe(`look at ${word} please`);
  });

  it("still records the message as written on the local machine", async () => {
    sandbox.liveRule({ name: "Mail", conditions: ["Condition A."] });

    await runMessageHook(hookInput("Ping me at me@example.com"), { env: sandbox.env, matcher: standInMatcher() });

    expect(checks()[0]!.text).toBe("Ping me at me@example.com");
  });
});

describe("slash commands", () => {
  it("sends the matcher the text after the command name, never the command", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("/my-plugin:deploy-site and then make the header smaller"), {
      env: sandbox.env,
      matcher,
    });

    expect(matcher.calls[0]!.text).toBe("and then make the header smaller");
    expect(JSON.stringify(matcher.calls)).not.toContain("deploy-site");
    expect(checks()).toMatchObject([{ outcome: "nothing", text: "and then make the header smaller" }]);
  });

  it.each([
    ["a bare command", "/review"],
    ["a command with only short arguments", "/review-pr 123"],
    ["a command with two short words", "/deploy staging now"],
    ["a command followed by punctuation only", "/commit -- !!"],
  ])("skips %s and records the check as skipped", async (_label, prompt) => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({ "Condition A.": 1 });

    const output = await runMessageHook(hookInput(prompt), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(matcher.calls).toEqual([]);
    expect(checks()).toMatchObject([{ outcome: "skipped", text: prompt, error: null }]);
  });

  it("checks a message that starts with a path, not a command, as it is", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher();

    await runMessageHook(hookInput("/home/me/notes.md is out of date"), { env: sandbox.env, matcher });

    expect(matcher.calls[0]!.text).toBe("/home/me/notes.md is out of date");
  });

  it("attaches rules that fire on the text after the command", async () => {
    sandbox.liveRule({ name: "Visual", conditions: ["The message asks for a visual change."] });
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.8 });

    const output = await runMessageHook(hookInput("/plan then make the header smaller on mobile"), {
      env: sandbox.env,
      matcher,
    });

    expect(context(output)).toContain("Visual");
  });
});
