import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MalformedAnswerError } from "../src/matcher.ts";
import { ATTACHED_HEADER, REPORT_LINE, runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
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

  it("attaches above the cutoff and lists matched rules strongest first", async () => {
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
    expect(sandbox.query("SELECT * FROM matches")).toEqual([]);
  });

  it("prints nothing with no live rules and records that nothing matched, without calling the matcher", async () => {
    const matcher = standInMatcher();

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(matcher.calls).toEqual([]);
    expect(checks()).toMatchObject([{ outcome: "nothing", error: null }]);
  });

  it("matches a rule when any one of its conditions clears the cutoff and records each score", async () => {
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
    const matches = sandbox.query<{ text: string; score: number }>(
      "SELECT c.text, f.score FROM matches f JOIN conditions c ON c.id = f.condition_id",
    );
    expect(matches).toEqual([{ text: "Second condition.", score: 0.8 }]);
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
  it("records the check, every condition's score with its rule version, and each match", async () => {
    const matched = sandbox.liveRule({ name: "Matches", conditions: ["Condition A.", "Condition B."] });
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
      { rule_id: matched, version: 1, text: "Condition A.", score: 0.65 },
      { rule_id: matched, version: 1, text: "Condition B.", score: 0.2 },
      { rule_id: quiet, version: 1, text: "Condition C.", score: 0.4 },
    ]);
    const matches = sandbox.query<{ rule_id: number; version: number; text: string; score: number }>(
      `SELECT f.rule_id, v.number AS version, c.text, f.score
         FROM matches f JOIN versions v ON v.id = f.version_id JOIN conditions c ON c.id = f.condition_id
        WHERE f.check_id = ?`,
      check!.id,
    );
    expect(matches).toEqual([{ rule_id: matched, version: 1, text: "Condition A.", score: 0.65 }]);
  });
});

describe("a failed message check", () => {
  const RETRIED = (first: string) => ` (second try; the first failed: ${first})`;
  const BLOCKED = (failure: string) =>
    `Sally could not check this message against your rules: ${failure}. It was not sent to Claude.\n` +
    "Send it again to retry.\n" +
    'To let messages through when a check fails, switch off "Stop the turn when a check fails" on the Settings screen of Sally\'s web app, or run: ' +
    `node "${join(import.meta.dirname, "..", "src", "cli.ts").replaceAll("\\", "/")}" settings stop-on-failure off`;

  /** The block Claude Code is told to make: the reason is what the user sees. */
  const blocked = (output: string): string => {
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed).sort()).toEqual(["decision", "reason"]);
    expect(parsed.decision).toBe("block");
    return parsed.reason as string;
  };

  const fails = async (matcher: ReturnType<typeof standInMatcher>, error: string | RegExp, failure: string) => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    expect(blocked(output)).toBe(BLOCKED(failure));
    // One check record for both tries.
    expect(checks()).toHaveLength(1);
    const [check] = checks();
    expect(check!.outcome).toBe("failed");
    expect(check!.error).toMatch(error);
    expect(check!.error).toContain("(second try; the first failed: ");
    expect(matcher.calls).toHaveLength(2);
    expect(sandbox.query("SELECT * FROM matches")).toEqual([]);
  };

  it("gives up on each try after 10 seconds by default, then blocks the message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    let aborted = 0;
    const matcher = standInMatcher(
      {},
      {
        answer: (_conditions, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted++;
              reject(signal.reason);
            });
          }),
      },
    );

    const pending = runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9999);
    expect(matcher.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // The second try has the full time limit again.
    expect(matcher.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(blocked(await pending)).toBe(BLOCKED("Jev did not answer in time"));
    expect(aborted).toBe(2);
    expect(checks()).toMatchObject([
      { outcome: "failed", error: "timeout after 10000 ms" + RETRIED("timeout after 10000 ms") },
    ]);
  });

  it("blocks the message when the matcher errors twice", async () => {
    await fails(
      standInMatcher({}, { answer: async () => Promise.reject(new Error("Jev returned HTTP 503")) }),
      "Jev returned HTTP 503",
      "Jev returned HTTP 503",
    );
  });

  it("blocks the message when Jev cannot be reached", async () => {
    await fails(
      standInMatcher({}, { answer: async () => Promise.reject(new TypeError("fetch failed")) }),
      "fetch failed",
      "Jev could not be reached",
    );
  });

  it("blocks the message when the matcher's answer is malformed twice", async () => {
    await fails(
      standInMatcher({}, { answer: async () => Promise.reject(new MalformedAnswerError("response is not JSON")) }),
      /malformed answer/,
      "Jev's answer could not be read",
    );
  });

  it.each([
    ["a score that is not a number", Number.NaN],
    ["a score above 1", 1.5],
    ["a score below 0", -0.1],
  ])("blocks the message on %s", async (_label, value) => {
    await fails(
      standInMatcher(
        {},
        { answer: async (conditions) => ({ scores: { [conditions[0]!.id]: value }, inputTokens: 5 }) },
      ),
      /malformed answer/,
      "Jev's answer could not be read",
    );
  });

  it("blocks the message when a sent condition gets no answer", async () => {
    await fails(
      standInMatcher({}, { answer: async () => ({ scores: {}, inputTokens: 5 }) }),
      /malformed answer/,
      "Jev's answer could not be read",
    );
  });

  it("blocks the message with no API key, without a second try, and records the failure", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env });

    expect(blocked(output)).toBe(BLOCKED("no Jev API key is set"));
    expect(checks()).toMatchObject([{ outcome: "failed", error: "missing API key" }]);
  });

  it("attaches the rules when the second try succeeds, in one check record", async () => {
    sandbox.liveRule({ name: "Rule", instruction: "Do the thing.", conditions: ["Condition A."] });
    let tries = 0;
    const matcher = standInMatcher(
      {},
      {
        answer: async (conditions) => {
          if (++tries === 1) throw new Error("fetch failed");
          return { scores: Object.fromEntries(conditions.map((c) => [c.id, 0.9])), inputTokens: 42 };
        },
      },
    );

    const output = await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(context(output)).toContain("Do the thing.");
    expect(matcher.calls).toHaveLength(2);
    expect(checks()).toMatchObject([{ outcome: "attached", error: null }]);
  });

  it("records the tokens of both tries when the first answer could not be read", async () => {
    sandbox.liveRule({ name: "Rule", instruction: "Do the thing.", conditions: ["Condition A."] });
    let tries = 0;
    const matcher = standInMatcher(
      {},
      {
        answer: async (conditions) =>
          ++tries === 1
            ? { scores: {}, inputTokens: 5 }
            : { scores: Object.fromEntries(conditions.map((c) => [c.id, 0.9])), inputTokens: 7 },
      },
    );

    await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });

    expect(checks()).toMatchObject([{ outcome: "attached", input_tokens: 12, request_tokens: 7 }]);
  });

  it("lets the message through in silence when stopping on a failed check is switched off", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ stopOnFailure: false }));
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const matcher = standInMatcher({}, { answer: async () => Promise.reject(new Error("fetch failed")) });

    expect(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher })).toBe("");
    expect(await runMessageHook(hookInput("hello again"), { env: sandbox.env })).toBe("");
    expect(checks()).toMatchObject([{ outcome: "failed" }, { outcome: "failed", error: "missing API key" }]);
  });

  it("does not block a bare slash command, which is skipped without asking Jev", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });

    expect(await runMessageHook(hookInput("/clear"), { env: sandbox.env })).toBe("");
    expect(checks()).toMatchObject([{ outcome: "skipped" }]);
  });

  it("prints nothing for a message with no text", async () => {
    expect(await runMessageHook(hookInput("   "), { env: sandbox.env, matcher: standInMatcher() })).toBe("");
  });
});

describe("a broken Sally", () => {
  /** The warning shown to the user; nothing in the output blocks the message. */
  const warning = (output: string): string => {
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual(["systemMessage"]);
    return parsed.systemMessage as string;
  };

  it("lets the message through with a warning when the database cannot be opened", async () => {
    // The data directory is a file, so the database inside it cannot be opened.
    const blocked = join(sandbox.root, "not-a-directory");
    writeFileSync(blocked, "");
    const env = { ...sandbox.env, SALLY_DATA_DIR: join(blocked, "inside") };

    const output = await runMessageHook(hookInput("hello there"), { env, matcher: standInMatcher() });

    expect(warning(output)).toMatch(/^Sally is not working, so this message was not checked against your rules: /);
  });

  it("lets the message through with a warning when the database is not a database", async () => {
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    const dataDir = join(sandbox.root, "broken");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, basename(databasePath(sandbox.env))), "this is not a database");

    const output = await runMessageHook(hookInput("hello there"), {
      env: { ...sandbox.env, SALLY_DATA_DIR: dataDir },
      matcher: standInMatcher(),
    });

    expect(warning(output)).toMatch(/^Sally is not working, so this message was not checked against your rules: /);
  });

  it("lets through, with a warning, input it cannot read", async () => {
    const output = await runMessageHook("not json", { env: sandbox.env, matcher: standInMatcher() });

    expect(warning(output)).toMatch(/^Sally is not working, so this message was not checked against your rules: /);
  });
});

describe("several rules match", () => {
  const matches = () =>
    sandbox.query<{ name: string; score: number }>(
      "SELECT r.name, f.score FROM matches f JOIN rules r ON r.id = f.rule_id ORDER BY f.score DESC",
    );

  it("attaches every rule that matches, strongest first", async () => {
    const scores: Record<string, number> = { A: 0.7, B: 0.95, C: 0.62, D: 0.8, E: 0.9, F: 0.3 };
    for (const name of Object.keys(scores)) sandbox.liveRule({ name: `Rule ${name}`, conditions: [`Condition ${name}.`] });
    const matcher = standInMatcher(Object.fromEntries(Object.entries(scores).map(([k, v]) => [`Condition ${k}.`, v])));

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    const attached = ["Rule B", "Rule E", "Rule D", "Rule A", "Rule C"].map((name) => text.indexOf(name));
    expect(attached.every((i) => i >= 0)).toBe(true);
    expect(attached).toEqual([...attached].sort((a, b) => a - b));
    expect(text).not.toContain("Rule F");
    expect(matches()).toEqual([
      { name: "Rule B", score: 0.95 },
      { name: "Rule E", score: 0.9 },
      { name: "Rule D", score: 0.8 },
      { name: "Rule A", score: 0.7 },
      { name: "Rule C", score: 0.62 },
    ]);
    expect(checks()).toMatchObject([{ outcome: "attached" }]);
  });

  it("orders a rule by its best condition", async () => {
    sandbox.liveRule({ name: "Two conditions", conditions: ["Weak.", "Strong."] });
    sandbox.liveRule({ name: "One condition", conditions: ["Middle."] });
    const matcher = standInMatcher({ "Weak.": 0.61, "Strong.": 0.99, "Middle.": 0.9 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text.indexOf("Two conditions")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Two conditions")).toBeLessThan(text.indexOf("One condition"));
    expect(matches()).toEqual([
      { name: "Two conditions", score: 0.99 },
      { name: "One condition", score: 0.9 },
    ]);
  });
});

describe("stored settings", () => {
  it("reads the cutoff from the stored settings and records it on the check", async () => {
    sandbox.liveRule({ name: "Rule A", conditions: ["Condition A."] });
    sandbox.liveRule({ name: "Rule B", conditions: ["Condition B."] });
    sandbox.liveRule({ name: "Rule C", conditions: ["Condition C."] });
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.4 }));
    const matcher = standInMatcher({ "Condition A.": 0.45, "Condition B.": 0.5, "Condition C.": 0.39 });

    const text = context(await runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher }));

    expect(text.indexOf("Rule B")).toBeLessThan(text.indexOf("Rule A"));
    expect(text).not.toContain("Rule C");
    expect(checks()).toMatchObject([{ cutoff: 0.4, outcome: "attached" }]);
  });

  it("reads the time limit from the stored settings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
    sandbox.withRules((rules) => rules.updateSettings({ timeLimitMs: 500 }));
    const matcher = standInMatcher({}, { answer: () => new Promise(() => {}) });

    const pending = runMessageHook(hookInput("hello there"), { env: sandbox.env, matcher });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(JSON.parse(await pending).decision).toBe("block");
    expect(checks()).toMatchObject([{ outcome: "failed", error: expect.stringMatching(/^timeout after 500 ms /) }]);
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
    // A message this long is cut to its last part before checking.
    const sent = matcher.calls[0]!.text;
    expect(sent.length).toBeLessThan(`look at ${word} please`.length);
    expect(sent.endsWith("a please")).toBe(true);
    expect(`look at ${word} please`.endsWith(sent)).toBe(true);
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

  it("attaches rules that match on the text after the command", async () => {
    sandbox.liveRule({ name: "Visual", conditions: ["The message asks for a visual change."] });
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.8 });

    const output = await runMessageHook(hookInput("/plan then make the header smaller on mobile"), {
      env: sandbox.env,
      matcher,
    });

    expect(context(output)).toContain("Visual");
  });
});
