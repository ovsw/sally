import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    env: sandbox.childEnv(),
  });

it("prints nothing and exits successfully with no live rules", () => {
  const result = run(hookInput("hello there"));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(sandbox.query("SELECT outcome, error FROM checks")).toEqual([{ outcome: "nothing", error: null }]);
});

it("blocks the message and exits successfully with a live rule but no API key", () => {
  sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
  const result = run(hookInput("hello there"));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("Sally could not check this message against your rules: no Jev API key is set."),
  });
  expect(sandbox.query("SELECT outcome, error FROM checks")).toEqual([{ outcome: "failed", error: "missing API key" }]);
});

it("runs the reply hook: warns the user and exits successfully with a live reply rule but no API key", () => {
  sandbox.liveRule({ name: "Rule", checkType: "reply", conditions: ["Condition A."] });
  const result = spawnSync(process.execPath, [cli, "hook", "reply"], {
    input: JSON.stringify({ session_id: "s", cwd: "/work/project", stop_hook_active: false, last_assistant_message: "Done." }),
    encoding: "utf8",
    env: sandbox.childEnv(),
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    systemMessage: "Sally could not check this reply against your rules: no Jev API key is set. The reply was not checked.",
  });
  expect(sandbox.query("SELECT check_type, outcome, error FROM checks")).toEqual([
    { check_type: "reply", outcome: "failed", error: "missing API key" },
  ]);
});

it("lets the turn through with a warning and exits successfully on unreadable input", () => {
  const result = run("{ not json");
  expect(result.status).toBe(0);
  expect(Object.keys(JSON.parse(result.stdout))).toEqual(["systemMessage"]);
});

it("switches stopping on a failed check off and on from the command line", () => {
  const settings = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "settings", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...sandbox.env } });
  sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });

  expect(settings("stop-on-failure").stdout).toBe("Stop on failure is on: when a check fails, Sally stops the turn.\n");
  const off = settings("stop-on-failure", "off");
  expect(off.status).toBe(0);
  expect(off.stdout).toBe("Stop on failure is off: when a check fails, the turn goes through without your rules.\n");
  expect(run(hookInput("hello there")).stdout).toBe("");

  expect(settings("stop-on-failure", "on").status).toBe(0);
  expect(JSON.parse(run(hookInput("hello there")).stdout).decision).toBe("block");

  const wrong = settings("stop-on-failure", "maybe");
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toBe("Usage: sally settings stop-on-failure [on|off]\n");
});

it("loads none of the import on the hook path", () => {
  const loads = join(sandbox.root, "loads.txt");
  sandbox.liveRule({ name: "Rule", conditions: ["Condition A."] });
  for (const hook of ["message", "reply"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", join(import.meta.dirname, "support", "record-loads.ts"), cli, "hook", hook],
      {
        input: hookInput("hello there"),
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...sandbox.env, SALLY_TEST_LOADS: loads },
      },
    );
    expect(result.status).toBe(0);
  }
  const loaded = readFileSync(loads, "utf8").split("\n").filter(Boolean);
  // The recorder works: the hooks' own modules are listed.
  expect(loaded.some((url) => url.endsWith("/src/message-hook.ts"))).toBe(true);
  expect(loaded.filter((url) => /\/src\/(import|import-command)\.ts$/.test(url))).toEqual([]);
  expect(loaded.filter((url) => url.includes("/src/app/"))).toEqual([]);
});
