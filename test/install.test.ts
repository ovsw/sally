import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AUTHORITY_LINE, hookCommand } from "../src/install.ts";
import type { Env } from "../src/paths.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
let settingsPath: string;
let rulesPath: string;
beforeEach(() => {
  sandbox = createSandbox();
  settingsPath = join(sandbox.root, ".claude", "settings.json");
  rulesPath = join(sandbox.root, ".claude", "CLAUDE.md");
});
afterEach(() => sandbox.cleanup());

// Runs the real command with only the sandbox's environment, so HOME is the
// sandbox and the real Claude Code settings and rules file are out of reach.
const sally = (command: "install" | "uninstall", env: Env = {}) =>
  spawnSync(process.execPath, [cli, command], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...sandbox.env, ...env },
  });

const read = (path: string) => readFileSync(path, "utf8");
const settings = () => JSON.parse(read(settingsPath)) as Record<string, unknown>;

function writeFile(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const sallyHooks = {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("message") }] }],
  Stop: [{ hooks: [{ type: "command", command: hookCommand("reply") }] }],
};

const otherSettings = {
  permissions: { allow: ["Bash(git status)"] },
  env: { SOME_SETTING: "1" },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo before-prompt" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-send done", timeout: 5 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
  },
};
const otherRules = "# My rules\n\n- Keep replies short.\n";

it("registers both hooks and adds the authority line in a fresh home", () => {
  const result = sally("install");

  expect(result.status).toBe(0);
  expect(settings()).toEqual({ hooks: sallyHooks });
  expect(read(rulesPath)).toBe(AUTHORITY_LINE + "\n");
});

it("changes nothing when run a second time", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 2) + "\n");
  writeFile(rulesPath, otherRules);
  sally("install");
  const settingsAfterFirst = read(settingsPath);
  const rulesAfterFirst = read(rulesPath);

  const result = sally("install");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("Sally is already installed.\n");
  expect(read(settingsPath)).toBe(settingsAfterFirst);
  expect(read(rulesPath)).toBe(rulesAfterFirst);
});

it("adds its entries beside the user's own and leaves those untouched", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 2) + "\n");
  writeFile(rulesPath, otherRules);

  sally("install");

  expect(settings()).toEqual({
    ...otherSettings,
    hooks: {
      ...otherSettings.hooks,
      UserPromptSubmit: [...otherSettings.hooks.UserPromptSubmit, ...sallyHooks.UserPromptSubmit],
      Stop: [...otherSettings.hooks.Stop, ...sallyHooks.Stop],
    },
  });
  expect(read(rulesPath)).toBe(otherRules + "\n" + AUTHORITY_LINE + "\n");
});

it("uninstall removes exactly what install added", () => {
  const originalSettings = JSON.stringify(otherSettings, null, 2) + "\n";
  const originalRules = "# My rules\n\n- Keep replies short.\n\n";
  writeFile(settingsPath, originalSettings);
  writeFile(rulesPath, originalRules);
  sally("install");

  const result = sally("uninstall");

  expect(result.status).toBe(0);
  expect(read(settingsPath)).toBe(originalSettings);
  expect(read(rulesPath)).toBe(originalRules);
});

it("uninstall after an install into a fresh home leaves no Sally entries", () => {
  sally("install");

  sally("uninstall");

  expect(settings()).toEqual({});
  expect(read(rulesPath)).toBe("");
});

it("uninstall keeps entries the user added after install, including in the same hook lists", () => {
  writeFile(rulesPath, otherRules);
  sally("install");
  const installed = settings() as { hooks: Record<string, unknown[]> };
  installed.hooks.UserPromptSubmit!.push({ hooks: [{ type: "command", command: "echo later" }] });
  writeFile(settingsPath, JSON.stringify({ ...installed, model: "opus" }, null, 2) + "\n");
  writeFile(rulesPath, read(rulesPath) + "- A rule added later.\n");

  sally("uninstall");

  expect(settings()).toEqual({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo later" }] }] },
    model: "opus",
  });
  expect(read(rulesPath)).toBe(otherRules + "- A rule added later.\n");
});

it("uninstall changes nothing when Sally is not installed", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 4));
  writeFile(rulesPath, otherRules);

  const result = sally("uninstall");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("Sally is not installed.\n");
  expect(read(settingsPath)).toBe(JSON.stringify(otherSettings, null, 4));
  expect(read(rulesPath)).toBe(otherRules);
});

it("uninstall creates no files in a home without them", () => {
  sally("uninstall");

  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(rulesPath)).toBe(false);
});

it("keeps the settings file's indentation", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 4) + "\n");

  sally("install");

  expect(read(settingsPath)).toMatch(/^\{\n {4}"permissions"/);
});

it("refuses to touch a settings file that is not valid JSON, and changes nothing", () => {
  writeFile(settingsPath, "{ not json");

  for (const command of ["install", "uninstall"] as const) {
    const result = sally(command);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(read(settingsPath)).toBe("{ not json");
    expect(existsSync(rulesPath)).toBe(false);
  }
});

it("refuses settings whose hooks are not in Claude Code's shape, and changes nothing", () => {
  const odd = JSON.stringify({ hooks: { Stop: "not a list" } });
  writeFile(settingsPath, odd);

  const result = sally("install");

  expect(result.status).toBe(1);
  expect(read(settingsPath)).toBe(odd);
  expect(existsSync(rulesPath)).toBe(false);
});

// Root ignores file permissions, so the rules file cannot be made unwritable there.
it.skipIf(process.getuid?.() === 0)(
  "says which changes were made when the rules file cannot be written",
  () => {
    const locked = join(sandbox.root, "locked");
    writeFile(join(locked, "CLAUDE.md"), otherRules);
    mkdirSync(join(rulesPath, ".."), { recursive: true });
    symlinkSync(join(locked, "CLAUDE.md"), rulesPath);
    chmodSync(locked, 0o555);
    try {
      const result = sally("install");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Already done:");
      expect(result.stderr).toContain("Registered the message hook");
      expect(result.stderr).toContain('run "sally install" again');
      expect(settings()).toEqual({ hooks: sallyHooks });
    } finally {
      chmodSync(locked, 0o755);
    }
  },
);

it("uses CLAUDE_CONFIG_DIR when it is set", () => {
  const configDir = join(sandbox.root, "claude-config");

  sally("install", { CLAUDE_CONFIG_DIR: configDir });

  expect(JSON.parse(read(join(configDir, "settings.json")))).toEqual({ hooks: sallyHooks });
  expect(read(join(configDir, "CLAUDE.md"))).toBe(AUTHORITY_LINE + "\n");
  expect(existsSync(settingsPath)).toBe(false);
});

it("registers commands that run the hooks", () => {
  sally("install");
  const { hooks } = settings() as typeof otherSettings;

  for (const event of ["UserPromptSubmit", "Stop"] as const) {
    const command = hooks[event][0]!.hooks[0]!.command;
    const result = spawnSync("sh", ["-c", command], {
      input: JSON.stringify({ session_id: "s", cwd: "/work/project", prompt: "hello", last_assistant_message: "Done." }),
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...sandbox.env },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }
  expect(sandbox.query("SELECT check_type FROM checks ORDER BY id")).toEqual([
    { check_type: "message" },
    { check_type: "reply" },
  ]);
});
