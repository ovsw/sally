import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

// Runs the real command the hook runs, with only the sandbox's environment:
// no API key reaches it, so it never calls Jev.
const run = (stdin: string) =>
  spawnSync(process.execPath, [cli, "hook", "message"], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...sandbox.env },
  });

it("prints nothing and exits successfully with no live rules", () => {
  const result = run(hookInput("hello there"));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(sandbox.query("SELECT outcome, error FROM checks")).toEqual([{ outcome: "failed", error: "no live rules" }]);
});

it("prints nothing and exits successfully with a live rule but no API key", () => {
  sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
  const result = run(hookInput("hello there"));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(sandbox.query("SELECT outcome, error FROM checks")).toEqual([{ outcome: "failed", error: "missing API key" }]);
});

it("prints nothing and exits successfully on unreadable input", () => {
  const result = run("{ not json");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});
