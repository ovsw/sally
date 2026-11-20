import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

interface TurnRow {
  session_id: string | null;
  message_check_id: number | null;
  reply_check_id: number | null;
  reply: string;
  revised_reply: string | null;
}

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  vi.useRealTimers();
  sandbox.cleanup();
});

/** The input Claude Code sends the stop hook. */
const stopInput = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "session-1",
    transcript_path: join(sandbox.root, "missing.jsonl"),
    cwd: "/work/project",
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...extra,
  });

/** Writes a session transcript, one JSON entry per line, and returns its path. */
const transcript = (entries: unknown[]): string => {
  const path = join(sandbox.root, "transcript.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
};
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (id: string, ...content: unknown[]) => ({
  type: "assistant",
  message: { id, role: "assistant", content },
});
const text = (t: string) => ({ type: "text", text: t });

const checks = () =>
  sandbox.query<{ id: number; check_type: string; text: string; outcome: string; error: string | null }>(
    "SELECT id, check_type, text, outcome, error FROM checks ORDER BY id",
  );
const turns = () =>
  sandbox.query<TurnRow>(
    "SELECT session_id, message_check_id, reply_check_id, reply, revised_reply FROM turns ORDER BY id",
  );

const replyRule = (name = "Local link", conditions = ["The reply reports a visual change with no local link."]) =>
  sandbox.liveRule({ name, checkType: "reply", instruction: `Instruction for ${name}.`, conditions });

describe("reply check", () => {
  it("sends the reply back with text that says it is a check, not a message, and what to do with the reply", async () => {
    const instruction = "Give the exact localhost URL\nof the changed page.";
    sandbox.liveRule({
      name: "Local link",
      checkType: "reply",
      instruction,
      conditions: ["The reply reports a visual change with no local link."],
    });
    const matcher = standInMatcher({ "The reply reports a visual change with no local link.": 0.8 });

    const output = await runReplyHook(stopInput({ last_assistant_message: "Done, the header is smaller." }), {
      env: sandbox.env,
      matcher,
    });

    const parsed = JSON.parse(output);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toMatch(/^Sally, an automatic check on the reply you just wrote, not a message to answer/);
    expect(parsed.reason).toContain(`Rule: Local link\n${instruction}`);
    expect(parsed.reason).toContain("If it breaks one, write the corrected reply, to the user and about their request.");
    expect(parsed.reason).toContain("If it already follows them, give the user its short version again.");
    expect(parsed.reason).toContain("do not mention Sally, these rules or this check.");
    expect(parsed.reason).toMatch(/If one of these rules does not fit, run this and leave it out of your reply: .+ false-positive "<rule name>"$/);
    expect(matcher.calls).toHaveLength(1);
    expect(matcher.calls[0]!.text).toBe("Done, the header is smaller.");
    expect(checks()).toMatchObject([{ check_type: "reply", text: "Done, the header is smaller.", outcome: "sent_back" }]);
  });

  it("lets the reply through below the cutoff and still records it", async () => {
    replyRule();
    const matcher = standInMatcher({ "The reply reports a visual change with no local link.": 0.59 });

    const output = await runReplyHook(stopInput({ last_assistant_message: "All done." }), { env: sandbox.env, matcher });

    expect(output).toBe("");
    expect(checks()).toMatchObject([{ check_type: "reply", outcome: "nothing" }]);
    expect(turns()).toMatchObject([{ reply: "All done.", revised_reply: null }]);
  });

  it("judges a reply against the reply cutoff, apart from the message cutoff", async () => {
    replyRule();
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.5, replyCutoff: 0.8 }));
    const matcher = standInMatcher({ "The reply reports a visual change with no local link.": 0.75 });

    const below = await runReplyHook(stopInput({ last_assistant_message: "The header is smaller." }), {
      env: sandbox.env,
      matcher,
    });
    expect(below).toBe("");

    sandbox.withRules((rules) => rules.updateSettings({ replyCutoff: 0.7 }));
    const above = await runReplyHook(stopInput({ last_assistant_message: "The footer is smaller." }), {
      env: sandbox.env,
      matcher,
    });
    expect(JSON.parse(above).decision).toBe("block");
    expect(sandbox.query("SELECT outcome, cutoff FROM checks ORDER BY id")).toEqual([
      { outcome: "nothing", cutoff: 0.8 },
      { outcome: "sent_back", cutoff: 0.7 },
    ]);
  });

  it("scores only reply-check rules", async () => {
    replyRule("Reply rule", ["The reply is unfinished."]);
    sandbox.liveRule({ name: "Message rule", conditions: ["The message is a question."] });
    const matcher = standInMatcher({ "The message is a question.": 1 });

    const output = await runReplyHook(stopInput({ last_assistant_message: "Is this a question?" }), {
      env: sandbox.env,
      matcher,
    });

    expect(output).toBe("");
    expect(matcher.calls[0]!.conditions.map((c) => c.text)).toEqual(["The reply is unfinished."]);
  });
});

describe("the once-per-turn guard", () => {
  it("records the revised reply beside the original and lets it through without asking the matcher", async () => {
    sandbox.liveRule({ name: "Message rule", conditions: ["The message asks for a change."] });
    replyRule();
    const matcher = standInMatcher({
      "The message asks for a change.": 0.9,
      "The reply reports a visual change with no local link.": 0.9,
    });

    await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const first = await runReplyHook(stopInput({ last_assistant_message: "Done." }), { env: sandbox.env, matcher });
    expect(JSON.parse(first).decision).toBe("block");
    expect(matcher.calls).toHaveLength(2);

    const second = await runReplyHook(
      stopInput({ stop_hook_active: true, last_assistant_message: "Done: http://localhost:3000/" }),
      { env: sandbox.env, matcher },
    );

    expect(second).toBe("");
    expect(matcher.calls).toHaveLength(2);
    const [message, reply, revised] = checks();
    expect([message!.check_type, reply!.outcome, revised!.outcome]).toEqual(["message", "sent_back", "skipped"]);
    expect(revised).toMatchObject({ check_type: "reply", text: "Done: http://localhost:3000/" });
    expect(turns()).toEqual([
      {
        session_id: "session-1",
        message_check_id: message!.id,
        reply_check_id: reply!.id,
        reply: "Done.",
        revised_reply: "Done: http://localhost:3000/",
      },
    ]);
  });
});

describe("recording every turn", () => {
  it("ties each turn's reply to that turn's message check", async () => {
    replyRule();
    const matcher = standInMatcher();

    await runMessageHook(hookInput("First message"), { env: sandbox.env, matcher });
    await runReplyHook(stopInput({ last_assistant_message: "First reply." }), { env: sandbox.env, matcher });
    await runMessageHook(hookInput("Other session", { session_id: "session-2" }), { env: sandbox.env, matcher });
    await runMessageHook(hookInput("Second message"), { env: sandbox.env, matcher });
    await runReplyHook(stopInput({ last_assistant_message: "Second reply." }), { env: sandbox.env, matcher });
    // A turn that started without a message check is not tied to an earlier one.
    await runReplyHook(stopInput({ last_assistant_message: "Third reply." }), { env: sandbox.env, matcher });

    const messageChecks = sandbox.query<{ id: number; text: string }>(
      "SELECT id, text FROM checks WHERE check_type = 'message' ORDER BY id",
    );
    const id = (t: string) => messageChecks.find((c) => c.text === t)!.id;
    expect(turns().map((t) => [t.reply, t.message_check_id])).toEqual([
      ["First reply.", id("First message")],
      ["Second reply.", id("Second message")],
      ["Third reply.", null],
    ]);
  });

  it("does not tie a later turn to an earlier message whose turn ended with no reply", async () => {
    replyRule();
    const matcher = standInMatcher();

    await runMessageHook(hookInput("Unanswered message"), { env: sandbox.env, matcher });
    await runMessageHook(hookInput("Answered message"), { env: sandbox.env, matcher });
    await runReplyHook(stopInput({ last_assistant_message: "Answer." }), { env: sandbox.env, matcher });
    await runReplyHook(stopInput({ last_assistant_message: "Reply with no message check." }), {
      env: sandbox.env,
      matcher,
    });

    const answered = sandbox.query<{ id: number }>("SELECT id FROM checks WHERE text = 'Answered message'")[0]!.id;
    expect(turns().map((t) => [t.reply, t.message_check_id])).toEqual([
      ["Answer.", answered],
      ["Reply with no message check.", null],
    ]);
  });
});

describe("reading the final reply", () => {
  it("falls back to the last assistant text in the transcript, without reasoning or tool output", async () => {
    replyRule();
    const matcher = standInMatcher();
    const path = transcript([
      user("Fix the header"),
      assistant("msg_1", { type: "thinking", thinking: "EARLY REASONING" }, text("Let me look at the header.")),
      assistant("msg_1", { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "header.tsx" } }),
      user([{ type: "tool_result", tool_use_id: "tool_1", content: "TOOL OUTPUT" }]),
      assistant("msg_2", { type: "thinking", thinking: "FINAL REASONING" }),
      assistant("msg_2", text("The header is smaller now.")),
      assistant("msg_2", text("Check it at http://localhost:3000/.")),
      { type: "system", content: "SYSTEM NOTE" },
    ]);

    await runReplyHook(stopInput({ transcript_path: path }), { env: sandbox.env, matcher });

    expect(matcher.calls).toHaveLength(1);
    expect(matcher.calls[0]!.text).toBe("The header is smaller now.\n\nCheck it at http://localhost:3000/.");
    expect(turns()).toMatchObject([{ reply: "The header is smaller now.\n\nCheck it at http://localhost:3000/." }]);
  });

  it("prefers the reply in the hook input over the transcript", async () => {
    replyRule();
    const matcher = standInMatcher();
    const path = transcript([user("Hi"), assistant("msg_1", text("From the transcript."))]);

    await runReplyHook(stopInput({ transcript_path: path, last_assistant_message: "From the hook input." }), {
      env: sandbox.env,
      matcher,
    });

    expect(matcher.calls[0]!.text).toBe("From the hook input.");
  });

  it("finds the final reply at the end of a long transcript", async () => {
    replyRule();
    const matcher = standInMatcher();
    const filler = "x".repeat(10_000);
    const finalReply = `The start. ${"y".repeat(400_000)} The end.`;
    const path = transcript([
      ...Array.from({ length: 100 }, (_, i) => [user(`Message ${i}`), assistant(`msg_${i}`, text(filler))]).flat(),
      user("Last message"),
      assistant("msg_last", text(finalReply)),
    ]);

    await runReplyHook(stopInput({ transcript_path: path }), { env: sandbox.env, matcher });

    // A reply this long keeps its start and end before checking.
    const sent = matcher.calls[0]!.text;
    expect(sent.length).toBeLessThan(finalReply.length);
    expect(sent.startsWith("The start. y")).toBe(true);
    expect(sent.endsWith("y The end.")).toBe(true);
  });

  it("does nothing when there is no reply text", async () => {
    replyRule();
    const matcher = standInMatcher();
    const path = transcript([user("Hi"), assistant("msg_1", { type: "tool_use", id: "t", name: "Bash", input: {} })]);

    expect(await runReplyHook(stopInput({ transcript_path: path }), { env: sandbox.env, matcher })).toBe("");
    expect(await runReplyHook(stopInput(), { env: sandbox.env, matcher })).toBe("");
    expect(matcher.calls).toEqual([]);
  });
});

describe("a failed reply check", () => {
  const RETRIED = (first: string) => ` (second try; the first failed: ${first})`;

  /** Runs the hook on a reply whose check fails, and returns what the user is shown. */
  const warning = async (options: Parameters<typeof runReplyHook>[1], error: string): Promise<string> => {
    replyRule();
    const output = JSON.parse(await runReplyHook(stopInput({ last_assistant_message: "All done." }), options));
    // A warning for the user only: nothing makes Claude continue.
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(checks()).toMatchObject([{ check_type: "reply", outcome: "failed", error }]);
    expect(turns()).toMatchObject([{ reply: "All done." }]);
    return output.systemMessage as string;
  };

  it("warns the user that the reply was not checked when the matcher errors", async () => {
    const matcher = standInMatcher({}, { answer: () => Promise.reject(new Error("Jev returned HTTP 503")) });
    expect(await warning({ env: sandbox.env, matcher }, "Jev returned HTTP 503" + RETRIED("Jev returned HTTP 503"))).toBe(
      "Sally could not check this reply against your rules: Jev returned HTTP 503. The reply was not checked.",
    );
    expect(matcher.calls).toHaveLength(2);
  });

  it("warns the user on a timeout", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ timeLimitMs: 10 }));
    const matcher = standInMatcher({}, { answer: () => new Promise(() => {}) });
    expect(await warning({ env: sandbox.env, matcher }, "timeout after 10 ms" + RETRIED("timeout after 10 ms"))).toBe(
      "Sally could not check this reply against your rules: Jev did not answer in time. The reply was not checked.",
    );
  });

  it("warns the user with no API key, without a second try", async () => {
    expect(await warning({ env: sandbox.env }, "missing API key")).toBe(
      "Sally could not check this reply against your rules: no Jev API key is set. The reply was not checked.",
    );
  });

  it("sends the reply back when the second try succeeds", async () => {
    replyRule();
    let tries = 0;
    const matcher = standInMatcher({}, {
      answer: async (conditions) => {
        if (++tries === 1) throw new Error("fetch failed");
        return { scores: Object.fromEntries(conditions.map((c) => [c.id, 0.9])), inputTokens: 42 };
      },
    });
    const output = JSON.parse(await runReplyHook(stopInput({ last_assistant_message: "All done." }), { env: sandbox.env, matcher }));
    expect(output.decision).toBe("block");
    expect(checks()).toMatchObject([{ outcome: "sent_back", error: null }]);
  });

  it("lets the reply through in silence when stopping on a failed check is switched off", async () => {
    sandbox.withRules((rules) => rules.updateSettings({ stopOnFailure: false }));
    replyRule();
    const matcher = standInMatcher({}, { answer: () => Promise.reject(new Error("fetch failed")) });
    expect(await runReplyHook(stopInput({ last_assistant_message: "All done." }), { env: sandbox.env, matcher })).toBe("");
    expect(checks()).toMatchObject([{ outcome: "failed" }]);
  });

  it("lets the reply through with a warning when Sally cannot open its database", async () => {
    // The data directory is a file, so the database inside it cannot be opened.
    const blocked = join(sandbox.root, "not-a-directory");
    writeFileSync(blocked, "");
    const env = { ...sandbox.env, SALLY_DATA_DIR: join(blocked, "inside") };
    const output = JSON.parse(await runReplyHook(stopInput({ last_assistant_message: "All done." }), { env, matcher: standInMatcher() }));
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(output.systemMessage).toMatch(/^Sally is not working, so this reply was not checked against your rules: /);
  });
});

describe("a rule in both checks", () => {
  const forMessage = "The message asks for a visual change.";
  const forReply = "The reply reports a visual change with no local link.";
  const instruction = "Give the localhost link before a pull request.";
  const bothChecks = () =>
    sandbox.liveRule({
      name: "Local link",
      instruction,
      conditions: [
        { text: forMessage, message: true, reply: false },
        { text: forReply, message: false, reply: true },
      ],
    });
  const scored = () =>
    sandbox.query<{ check_type: string; text: string }>(
      `SELECT c.check_type, vc.text FROM scores s
         JOIN checks c ON c.id = s.check_id
         JOIN version_conditions vc ON vc.version_id = s.version_id AND vc.condition_id = s.condition_id
        ORDER BY s.check_id, vc.position`,
    );

  it("is attached on a matching message and sent back on a matching reply in the same turn", async () => {
    bothChecks();
    const matcher = standInMatcher({ [forMessage]: 0.9, [forReply]: 0.9 });

    const attached = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const sentBack = await runReplyHook(stopInput({ last_assistant_message: "Done, the header is smaller." }), {
      env: sandbox.env,
      matcher,
    });

    expect(JSON.parse(attached).hookSpecificOutput.additionalContext).toContain(`Rule: Local link\n${instruction}`);
    expect(JSON.parse(sentBack)).toMatchObject({ decision: "block", reason: expect.stringContaining(instruction) });
    // Each check sends only the conditions on for it.
    expect(matcher.calls.map((call) => call.conditions.map((c) => c.text))).toEqual([[forMessage], [forReply]]);
    expect(checks()).toMatchObject([
      { check_type: "message", outcome: "attached" },
      { check_type: "reply", outcome: "sent_back" },
    ]);
    expect(turns()).toMatchObject([{ message_check_id: 1, reply_check_id: 2 }]);
  });

  it("never attaches a rule for a Reply condition, nor sends a reply back for a Message condition", async () => {
    sandbox.liveRule({ name: "Reply only", checkType: "reply", instruction: "Reply instruction.", conditions: [forReply] });
    sandbox.liveRule({ name: "Message only", instruction: "Message instruction.", conditions: [forMessage] });
    const matcher = standInMatcher({ [forMessage]: 0.99, [forReply]: 0.99 });

    const attached = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const sentBack = await runReplyHook(stopInput({ last_assistant_message: "Done." }), { env: sandbox.env, matcher });

    const context: string = JSON.parse(attached).hookSpecificOutput.additionalContext;
    expect(context).toContain("Message instruction.");
    expect(context).not.toContain("Reply instruction.");
    const reason: string = JSON.parse(sentBack).reason;
    expect(reason).toContain("Reply instruction.");
    expect(reason).not.toContain("Message instruction.");
    expect(scored()).toEqual([
      { check_type: "message", text: forMessage },
      { check_type: "reply", text: forReply },
    ]);
  });

  it("gives a condition with both switches off no score", async () => {
    sandbox.liveRule({
      name: "Local link",
      conditions: [
        { text: forMessage, message: true, reply: false },
        { text: "A condition switched off.", message: false, reply: false },
      ],
    });
    const matcher = standInMatcher({ [forMessage]: 0.1, "A condition switched off.": 0.99 });

    expect(await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher })).toBe("");
    expect(await runReplyHook(stopInput({ last_assistant_message: "Done." }), { env: sandbox.env, matcher })).toBe("");

    expect(scored()).toEqual([{ check_type: "message", text: forMessage }]);
    expect(checks()).toMatchObject([
      { check_type: "message", outcome: "nothing" },
      { check_type: "reply", outcome: "nothing" },
    ]);
  });

  it("uses a condition's switches as they are at each check, once switched", async () => {
    const ruleId = bothChecks();
    const matcher = standInMatcher({ [forMessage]: 0.9, [forReply]: 0.9 });
    const [messageCondition, replyCondition] = sandbox.withRules((rules) => rules.getRule(ruleId).live!.conditions);
    sandbox.withRules((rules) => {
      rules.setConditionSwitch(ruleId, messageCondition!.id, "message", false);
      rules.setConditionSwitch(ruleId, replyCondition!.id, "message", true);
    });

    const attached = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    sandbox.withRules((rules) => rules.setConditionSwitch(ruleId, replyCondition!.id, "reply", false));
    const sentBack = await runReplyHook(stopInput({ last_assistant_message: "Done." }), { env: sandbox.env, matcher });

    expect(attached).toContain(instruction);
    expect(sentBack).toBe("");
    // The switched-off condition got no score in either check.
    expect(scored()).toEqual([{ check_type: "message", text: forReply }]);
    expect(checks()).toMatchObject([
      { check_type: "message", outcome: "attached" },
      { check_type: "reply", outcome: "nothing" },
    ]);
  });

  it("judges each check at its own cutoff", async () => {
    bothChecks();
    sandbox.withRules((rules) => rules.updateSettings({ cutoff: 0.5, replyCutoff: 0.8 }));
    const matcher = standInMatcher({ [forMessage]: 0.7, [forReply]: 0.7 });

    const attached = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const sentBack = await runReplyHook(stopInput({ last_assistant_message: "Done." }), { env: sandbox.env, matcher });

    expect(attached).toContain(instruction);
    expect(sentBack).toBe("");
    expect(checks()).toMatchObject([
      { check_type: "message", outcome: "attached" },
      { check_type: "reply", outcome: "nothing" },
    ]);
  });
});
