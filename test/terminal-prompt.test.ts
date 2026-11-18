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
  terminal.input.write("save\n");

  expect(await answer).toBe("save");
  prompt.close();
  expect(terminal.shown()).toContain("save");
});
