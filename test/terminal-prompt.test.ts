import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { terminalPrompt } from "../src/terminal-prompt.ts";

/** A terminal stand-in: keystrokes go into `input`, and everything shown is collected. */
function fakeTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => (shown += chunk.toString("utf8")));
  return { input, output, shown: () => shown };
}

it("reads a hidden answer without showing what was typed", async () => {
  const terminal = fakeTerminal();
  const prompt = terminalPrompt(terminal.input, terminal.output);

  const answer = prompt.askHidden("Paste your key: ");
  terminal.input.write("sk-secret-123\n");

  expect(await answer).toBe("sk-secret-123");
  prompt.close();
  expect(terminal.shown()).toContain("Paste your key: ");
  expect(terminal.shown()).not.toContain("secret");
});

it("shows an ordinary answer as it is typed", async () => {
  const terminal = fakeTerminal();
  const prompt = terminalPrompt(terminal.input, terminal.output);

  const answer = prompt.ask("Paste again or save? ");
  terminal.input.write("anyway\n");

  expect(await answer).toBe("anyway");
  prompt.close();
  expect(terminal.shown()).toContain("anyway");
});

it("does not bring a hidden answer back with the Up key at the next question", async () => {
  const terminal = fakeTerminal();
  const prompt = terminalPrompt(terminal.input, terminal.output);

  const hidden = prompt.askHidden("Paste your key: ");
  terminal.input.write("sk-secret-123\n");
  await hidden;

  const next = prompt.ask("Paste again or save? ");
  terminal.input.write("\x1b[A\n");

  expect(await next).toBe("");
  prompt.close();
  expect(terminal.shown()).not.toContain("secret");
});

it("does not bring back erased hidden input with Ctrl-Y at the next question", async () => {
  const terminal = fakeTerminal();
  const prompt = terminalPrompt(terminal.input, terminal.output);

  const hidden = prompt.askHidden("Paste your key: ");
  // Type a key, erase the line with Ctrl-U, then type another.
  terminal.input.write("sk-secret-123\x15sk-other-456\n");
  expect(await hidden).toBe("sk-other-456");

  const next = prompt.ask("Paste again or save? ");
  terminal.input.write("\x19\n");

  expect(await next).toBe("");
  prompt.close();
  expect(terminal.shown()).not.toContain("secret");
});

it("fails a question when the input ends before an answer", async () => {
  const terminal = fakeTerminal();
  const prompt = terminalPrompt(terminal.input, terminal.output);

  const answer = prompt.ask("Paste again or save? ");
  terminal.input.end();

  await expect(answer).rejects.toThrow("Input ended");
});
