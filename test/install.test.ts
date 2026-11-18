import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_LINE,
  hookEntry,
  install,
  MIN_CLAUDE_CODE_VERSION,
  skillInstructionsPath,
  skillPath,
} from "../src/install.ts";
import type { Env } from "../src/paths.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
let settingsPath: string;
let rulesPath: string;
let fakeBin: string;
beforeEach(() => {
  sandbox = createSandbox();
  settingsPath = join(sandbox.root, ".claude", "settings.json");
  rulesPath = join(sandbox.root, ".claude", "CLAUDE.md");
  fakeBin = join(sandbox.root, "bin");
  fakeClaude("2.1.200");
});
afterEach(() => sandbox.cleanup());

/** Puts a stand-in `claude` first on the PATH, printing `version` for `claude --version`. */
function fakeClaude(version: string) {
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, "claude.cmd"), `@echo ${version} (Claude Code)\r\n`);
}

// Runs the real command with only the sandbox's environment, so HOME is the
// sandbox and the real Claude Code settings and rules file are out of reach.
const sally = (command: "sally-install" | "sally-uninstall", env: Env = {}) =>
  spawnSync(process.execPath, [cli, command], {
    encoding: "utf8",
    env: sandbox.childEnv({ PATH: fakeBin + delimiter + process.env.PATH, ...env }),
  });

const read = (path: string) => readFileSync(path, "utf8");
const settings = () => JSON.parse(read(settingsPath)) as Record<string, unknown>;

function writeFile(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const sallyHooks = {
  UserPromptSubmit: [{ hooks: [hookEntry("message")] }],
  Stop: [{ hooks: [hookEntry("reply")] }],
};

/** Sally's hooks as earlier installs wrote them: one shell command line each. */
const oldFormHooks = {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "node '/old checkout/sally/src/cli.ts' hook message" }] }],
  Stop: [{ hooks: [{ type: "command", command: "node /work/sally/src/cli.ts hook reply" }] }],
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
  const result = sally("sally-install");

  expect(result.status).toBe(0);
  expect(settings()).toEqual({ hooks: sallyHooks });
  expect(read(rulesPath)).toBe(AUTHORITY_LINE + "\n");
});

it("changes nothing when run a second time", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 2) + "\n");
  writeFile(rulesPath, otherRules);
  sally("sally-install");
  const settingsAfterFirst = read(settingsPath);
  const rulesAfterFirst = read(rulesPath);

  const result = sally("sally-install");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("Sally is already installed.\n");
  expect(read(settingsPath)).toBe(settingsAfterFirst);
  expect(read(rulesPath)).toBe(rulesAfterFirst);
});

it("adds its entries beside the user's own and leaves those untouched", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 2) + "\n");
  writeFile(rulesPath, otherRules);

  sally("sally-install");

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
  sally("sally-install");

  const result = sally("sally-uninstall");

  expect(result.status).toBe(0);
  expect(read(settingsPath)).toBe(originalSettings);
  expect(read(rulesPath)).toBe(originalRules);
});

it("uninstall after an install into a fresh home leaves no Sally entries", () => {
  sally("sally-install");

  sally("sally-uninstall");

  expect(settings()).toEqual({});
  expect(read(rulesPath)).toBe("");
});

it("uninstall keeps entries the user added after install, including in the same hook lists", () => {
  writeFile(rulesPath, otherRules);
  sally("sally-install");
  const installed = settings() as { hooks: Record<string, unknown[]> };
  installed.hooks.UserPromptSubmit!.push({ hooks: [{ type: "command", command: "echo later" }] });
  writeFile(settingsPath, JSON.stringify({ ...installed, model: "opus" }, null, 2) + "\n");
  writeFile(rulesPath, read(rulesPath) + "- A rule added later.\n");

  sally("sally-uninstall");

  expect(settings()).toEqual({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo later" }] }] },
    model: "opus",
  });
  expect(read(rulesPath)).toBe(otherRules + "- A rule added later.\n");
});

it("uninstall changes nothing when Sally is not installed", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 4));
  writeFile(rulesPath, otherRules);

  const result = sally("sally-uninstall");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("Sally is not installed.\n");
  expect(read(settingsPath)).toBe(JSON.stringify(otherSettings, null, 4));
  expect(read(rulesPath)).toBe(otherRules);
});

it("uninstall creates no files in a home without them", () => {
  sally("sally-uninstall");

  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(rulesPath)).toBe(false);
});

it("keeps the settings file's indentation", () => {
  writeFile(settingsPath, JSON.stringify(otherSettings, null, 4) + "\n");

  sally("sally-install");

  expect(read(settingsPath)).toMatch(/^\{\n {4}"permissions"/);
});

it("no longer answers to the old names: install and uninstall print the usage and change nothing", () => {
  for (const command of ["install", "uninstall"]) {
    const result = spawnSync(process.execPath, [cli, command], { encoding: "utf8", env: sandbox.childEnv() });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: node src/cli.ts sally-install [--yes]");
    expect(result.stderr).toContain("node src/cli.ts sally-uninstall");
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(rulesPath)).toBe(false);
  }
});

it("refuses to touch a settings file that is not valid JSON, and changes nothing", () => {
  writeFile(settingsPath, "{ not json");

  for (const command of ["sally-install", "sally-uninstall"] as const) {
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

  const result = sally("sally-install");

  expect(result.status).toBe(1);
  expect(read(settingsPath)).toBe(odd);
  expect(existsSync(rulesPath)).toBe(false);
});

// Root ignores file permissions, so the rules file cannot be made unwritable
// there; Windows has neither these permission bits nor unprivileged symlinks.
it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
  "says which changes were made when the rules file cannot be written",
  () => {
    const locked = join(sandbox.root, "locked");
    writeFile(join(locked, "CLAUDE.md"), otherRules);
    mkdirSync(join(rulesPath, ".."), { recursive: true });
    symlinkSync(join(locked, "CLAUDE.md"), rulesPath);
    chmodSync(locked, 0o555);
    try {
      const result = sally("sally-install");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Already done:");
      expect(result.stderr).toContain("Registered the message hook");
      expect(result.stderr).toContain('run "node src/cli.ts sally-install" again');
      expect(settings()).toEqual({ hooks: sallyHooks });
    } finally {
      chmodSync(locked, 0o755);
    }
  },
);

it("uses CLAUDE_CONFIG_DIR when it is set", () => {
  const configDir = join(sandbox.root, "claude-config");

  sally("sally-install", { CLAUDE_CONFIG_DIR: configDir });

  expect(JSON.parse(read(join(configDir, "settings.json")))).toEqual({ hooks: sallyHooks });
  expect(read(join(configDir, "CLAUDE.md"))).toBe(AUTHORITY_LINE + "\n");
  expect(existsSync(settingsPath)).toBe(false);
});

type Settings = { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };

/** Runs each registered hook the way Claude Code's exec form does: the program and its arguments, no shell. */
function runRegisteredHooks() {
  const { hooks } = settings() as Settings;
  for (const event of ["UserPromptSubmit", "Stop"] as const) {
    const entry = hooks[event]![0]!.hooks[0]!;
    expect(typeof entry.command).toBe("string");
    expect(Array.isArray(entry.args)).toBe(true);
    const result = spawnSync(entry.command as string, entry.args as string[], {
      input: JSON.stringify({ session_id: "s", cwd: sandbox.root, prompt: "hello", last_assistant_message: "Done." }),
      encoding: "utf8",
      env: sandbox.childEnv(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }
  expect(sandbox.query("SELECT check_type FROM checks ORDER BY id")).toEqual([
    { check_type: "message" },
    { check_type: "reply" },
  ]);
}

it("registers each hook as a program plus arguments, with no shell quoting", () => {
  sally("sally-install");

  const { hooks } = settings() as Settings;
  expect(hooks.UserPromptSubmit![0]!.hooks[0]).toEqual({ type: "command", command: "node", args: [cli, "hook", "message"] });
  expect(hooks.Stop![0]!.hooks[0]).toEqual({ type: "command", command: "node", args: [cli, "hook", "reply"] });
});

it("registers hooks that run", () => {
  sally("sally-install");

  runRegisteredHooks();
});

it("registers hooks that run from a folder whose name has spaces and quotes", () => {
  // A command line that stands in for a checkout in an awkward folder.
  // Windows does not allow double quotes in file names.
  const folder = process.platform === "win32" ? "Jane O'Doe's files $HOME" : `Jane O'Doe's "files" $HOME`;
  const awkward = join(sandbox.root, folder, "sally", "src", "cli.ts");
  mkdirSync(join(awkward, ".."), { recursive: true });
  writeFileSync(awkward, `import ${JSON.stringify(pathToFileURL(cli).href)};\n`);

  install({ env: sandbox.env, cliPath: awkward, claudeVersion: () => undefined });

  expect((settings() as Settings).hooks.Stop![0]!.hooks[0]!.args).toEqual([awkward, "hook", "reply"]);
  runRegisteredHooks();
});

it("writes a Windows-style path as one argument, unchanged", () => {
  const windowsPath = "C:\\Users\\Jane Doe\\code\\sally\\src\\cli.ts";

  install({ env: sandbox.env, cliPath: windowsPath, claudeVersion: () => undefined });

  const { hooks } = settings() as Settings;
  expect(hooks.UserPromptSubmit![0]!.hooks[0]).toEqual({ type: "command", command: "node", args: [windowsPath, "hook", "message"] });

  // A later install from another checkout recognises it as Sally's and replaces it.
  install({ env: sandbox.env, claudeVersion: () => undefined });
  expect(settings()).toEqual({ hooks: sallyHooks });
});

it("replaces hooks of the earlier form, leaving one set in the new form", () => {
  writeFile(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo before-prompt" }, ...oldFormHooks.UserPromptSubmit[0]!.hooks] },
        ],
        Stop: [...oldFormHooks.Stop, { hooks: [hookEntry("reply")] }],
      },
    }),
  );

  const result = sally("sally-install");

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Replaced the earlier message hook");
  expect(settings()).toEqual({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo before-prompt" }, hookEntry("message")] }],
      Stop: [{ hooks: [hookEntry("reply")] }],
    },
  });

  const again = sally("sally-install");
  expect(again.stdout).toBe("Sally is already installed.\n");
});

it("uninstall removes Sally's hooks in either form and nothing else", () => {
  const userHooks = {
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: "node", args: ["/tools/cli.ts", "hook", "other"] }] },
      { hooks: [{ type: "command", command: "node /tools/notify.js hook message" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify-send done", timeout: 5 }] }],
  };
  writeFile(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [...userHooks.UserPromptSubmit, ...oldFormHooks.UserPromptSubmit, ...sallyHooks.UserPromptSubmit],
        Stop: [{ hooks: [...userHooks.Stop[0]!.hooks, ...oldFormHooks.Stop[0]!.hooks] }],
      },
    }),
  );

  const result = sally("sally-uninstall");

  expect(result.status).toBe(0);
  expect(settings()).toEqual({ hooks: userHooks });
});

it("leaves alone a user's own hook that only looks like Sally's", () => {
  // Another tool's command line, called the same way, in both forms.
  const lookalikes = {
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: "node", args: ["/tools/src/cli.ts", "hook", "message"] }] },
      { hooks: [{ type: "command", command: "node /tools/cli.ts hook message" }] },
    ],
  };
  writeFile(settingsPath, JSON.stringify({ hooks: lookalikes }));

  expect(sally("sally-install").status).toBe(0);
  expect(settings()).toEqual({
    hooks: { UserPromptSubmit: [...lookalikes.UserPromptSubmit, ...sallyHooks.UserPromptSubmit], Stop: sallyHooks.Stop },
  });

  expect(sally("sally-uninstall").status).toBe(0);
  expect(settings()).toEqual({ hooks: lookalikes });
});

it("says so when Claude Code is older than the first version that runs these hooks", () => {
  fakeClaude("2.1.100");

  const result = sally("sally-install");

  expect(result.status).toBe(0);
  expect(result.stderr).toContain(`Claude Code 2.1.100 is older than ${MIN_CLAUDE_CODE_VERSION}`);
  expect(settings()).toEqual({ hooks: sallyHooks });
});

it("says nothing about the version when Claude Code is new enough", () => {
  fakeClaude(MIN_CLAUDE_CODE_VERSION);

  expect(sally("sally-install").stderr).toBe("");
});

it("installs without a warning when Claude Code's version cannot be read", () => {
  const result = install({ env: sandbox.env, claudeVersion: () => undefined });

  expect(result.warnings).toEqual([]);
  expect(settings()).toEqual({ hooks: sallyHooks });
});

describe("the import skill", () => {
  const skill = () => skillPath(sandbox.env);
  const ownSkill = "---\nname: sally-import\ndescription: My own import.\n---\n\nDo it my way.\n";

  it("install adds it at the user level: marked as Sally's, pointing to the instructions and the command line", () => {
    const result = sally("sally-install");

    expect(result.status).toBe(0);
    expect(skill()).toBe(join(sandbox.root, ".claude", "skills", "sally-import", "SKILL.md"));
    const text = read(skill());
    expect(text.startsWith("---\nname: sally-import\n")).toBe(true);
    expect(text).toMatch(/^metadata:\n {2}installed-by: sally$/m);
    expect(text).toMatch(/^description: .*only when the user asks/m);
    expect(text).toContain(skillInstructionsPath());
    expect(existsSync(skillInstructionsPath())).toBe(true);
    expect(text).toContain(`node "${cli.replaceAll("\\", "/")}"`);
    expect(result.stdout).toContain(`Installed the import skill (/sally-import) at ${skill()}`);
  });

  it("a second install changes nothing; uninstall removes it and its folder", () => {
    sally("sally-install");
    const before = read(skill());
    const again = sally("sally-install");
    expect(again.stdout).toBe("Sally is already installed.\n");
    expect(read(skill())).toBe(before);

    const removed = sally("sally-uninstall");
    expect(removed.stdout).toContain("Removed the import skill (/sally-import)");
    expect(existsSync(join(skill(), ".."))).toBe(false);
    expect(existsSync(join(sandbox.root, ".claude", "skills"))).toBe(true);
  });

  it("install brings Sally's earlier skill up to date", () => {
    writeFile(skill(), "---\nname: sally-import\nmetadata:\n  installed-by: sally\n---\n\nOld instructions.\n");
    const result = sally("sally-install");
    expect(result.stdout).toContain("Updated the import skill");
    expect(read(skill())).toContain(skillInstructionsPath());
  });

  it("leaves a user's own skill of the same name alone, on install and on uninstall", () => {
    writeFile(skill(), ownSkill);

    const installed = sally("sally-install");
    expect(installed.status).toBe(0);
    expect(installed.stderr).toMatch(/already exists .* is not Sally's, so it was left alone/);
    expect(read(skill())).toBe(ownSkill);
    expect(read(rulesPath)).toBe(AUTHORITY_LINE + "\n");

    const uninstalled = sally("sally-uninstall");
    expect(uninstalled.status).toBe(0);
    expect(read(skill())).toBe(ownSkill);
    expect(uninstalled.stdout).not.toContain("import skill");
  });

  it("leaves a folder of that name alone even without a SKILL.md", () => {
    writeFile(join(skill(), "..", "notes.md"), "Mine.\n");
    sally("sally-install");
    expect(existsSync(skill())).toBe(false);
    sally("sally-uninstall");
    expect(read(join(skill(), "..", "notes.md"))).toBe("Mine.\n");
  });

  it("points to a checkout in a folder whose name has spaces", () => {
    const cliPath = join(sandbox.root, "my code", "sally", "src", "cli.ts");
    install({ env: sandbox.env, cliPath, claudeVersion: () => undefined });
    const text = read(skill());
    expect(text).toContain(`node "${cliPath.replaceAll("\\", "/")}"`);
    expect(text).toContain(join(sandbox.root, "my code", "sally", "skill", "import.md"));
  });
});
