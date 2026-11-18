import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_LINE, runMessageHook } from "../src/message-hook.ts";
import { formatSentBack, REVISE_LINE, runReplyHook, SENT_BACK_HEADER } from "../src/reply-hook.ts";
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
    expect(parsed.reason).toBe(
      formatSentBack([{ ruleId: 0, name: "Local link", instruction, score: 0.8 }]),
    );
    expect(parsed.reason.startsWith(SENT_BACK_HEADER)).toBe(true);
    expect(parsed.reason).toContain(`Rule: Local link\n${instruction}`);
    expect(parsed.reason.endsWith(`${REVISE_LINE}\n\n${REPORT_LINE}`)).toBe(true);
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
