import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHORITY_LINE, hookEntry, skillPath } from "../src/install.ts";
import { type InstallCommandOptions, runInstall, runUninstall } from "../src/install-command.ts";
import type { Matcher } from "../src/matcher.ts";
import { apiKeyPath, configDir, databasePath, type Env } from "../src/paths.ts";
import type { Prompt } from "../src/terminal-prompt.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
let settingsPath: string;
let rulesPath: string;
beforeEach(() => {
  sandbox = createSandbox();
  settingsPath = join(sandbox.root, ".claude", "settings.json");
  rulesPath = join(sandbox.root, ".claude", "CLAUDE.md");
});
afterEach(() => sandbox.cleanup());

const read = (path: string) => readFileSync(path, "utf8");
const isWindows = process.platform === "win32";

interface Question {
  text: string;
  hidden: boolean;
}

/** A prompt that answers from a script, in order, and fails on any question past its end. */
function scriptedPrompt(answers: string[]): Prompt & { asked: Question[] } {
  const asked: Question[] = [];
  const next = (text: string, hidden: boolean) => {
    asked.push({ text, hidden });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`Unexpected question: ${text}`);
    return Promise.resolve(answer);
  };
  return {
    asked,
    ask: (text) => next(text, false),
    askHidden: (text) => next(text, true),
    close() {},
  };
}

/** Keys the matcher accepts; any other key fails the test with `failure`. */
function keyTester(goodKeys: string[], failure: () => Error = () => new Error("Jev returned HTTP 401")) {
  const triedKeys: string[] = [];
  const matcherFor = (key: string): Matcher => {
    triedKeys.push(key);
    return standInMatcher(
      {},
      goodKeys.includes(key)
        ? {}
        : {
            answer: () => Promise.reject(failure()),
          },
    );
  };
  return { triedKeys, matcherFor };
}

async function guided(
  prompt: Prompt,
  options: Partial<InstallCommandOptions> & { env?: Env; args?: string[] } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runInstall(options.args ?? [], {
    isTerminal: true,
    openPrompt: () => prompt,
    matcherFor: keyTester(["good-key"]).matcherFor,
    claudeVersion: () => undefined,
    ...options,
    env: { ...sandbox.env, ...options.env },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

function uninstallNow() {
  let stdout = "";
  const code = runUninstall([], { env: sandbox.env, stdout: (t) => (stdout += t), stderr: () => {} });
  return { code, stdout };
}

const noPrompt = (): Prompt => {
  throw new Error("install asked a question");
};

describe("guided install in a terminal", () => {
  it("asks for the key with typing hidden, tests it through the matcher, saves it and sets everything up", async () => {
    const prompt = scriptedPrompt(["good-key"]);
    const keys = keyTester(["good-key"]);

    const result = await guided(prompt, { matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(prompt.asked).toEqual([{ text: expect.stringContaining("API key"), hidden: true }]);
    expect(keys.triedKeys).toEqual(["good-key"]);
    expect(result.stdout).toContain("The key works.");
    expect(read(apiKeyPath(sandbox.env)).trim()).toBe("good-key");
    expect(existsSync(databasePath(sandbox.env))).toBe(true);
    expect(sandbox.query("SELECT COUNT(*) AS rules FROM rules")).toEqual([{ rules: 0 }]);
    expect(JSON.parse(read(settingsPath))).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [hookEntry("message")] }], Stop: [{ hooks: [hookEntry("reply")] }] },
    });
    expect(read(rulesPath)).toBe(AUTHORITY_LINE + "\n");
    expect(result.stdout).toMatch(/Next step: import your rules/);
    expect(result.stdout).toContain("/sally-import");
    expect(existsSync(skillPath(sandbox.env))).toBe(true);
    expect(result.stdout).toContain("sally app");
    expect(result.stdout.trimEnd().split("\n").at(-2)).toMatch(/^Next step: import/);
  });

  it.skipIf(isWindows)("saves the key readable only by the user, in a folder only the user can enter", async () => {
    await guided(scriptedPrompt(["good-key"]));

    expect(statSync(apiKeyPath(sandbox.env)).mode & 0o777).toBe(0o600);
    expect(statSync(configDir(sandbox.env)).mode & 0o777).toBe(0o700);
  });

  it("uses a key from the environment, says so, still tests it, and asks nothing", async () => {
    const keys = keyTester(["good-key"]);

    const result = await guided(scriptedPrompt([]), { env: { TYPESAFE_API_KEY: "good-key" }, matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Using the API key from TYPESAFE_API_KEY.");
    expect(keys.triedKeys).toEqual(["good-key"]);
    expect(existsSync(apiKeyPath(sandbox.env))).toBe(false);
  });

  it("uses a key from the key file and says where it came from", async () => {
    mkdirSync(configDir(sandbox.env), { recursive: true, mode: 0o700 });
    writeFileSync(apiKeyPath(sandbox.env), "good-key\n", { mode: 0o600 });

    const result = await guided(scriptedPrompt([]));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Using the API key from ${apiKeyPath(sandbox.env)}.`);
    expect(read(apiKeyPath(sandbox.env))).toBe("good-key\n");
  });

  it("shows why a key failed and lets the user paste it again", async () => {
    const prompt = scriptedPrompt(["wrong-key", "p", "good-key"]);
    const keys = keyTester(["good-key"]);

    const result = await guided(prompt, { matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The key test failed: Jev refused the key (HTTP 401)");
    expect(prompt.asked.map((q) => q.hidden)).toEqual([true, false, true]);
    expect(keys.triedKeys).toEqual(["wrong-key", "good-key"]);
    expect(read(apiKeyPath(sandbox.env)).trim()).toBe("good-key");
  });

  it("saves a key that failed the test when the user says to save it anyway", async () => {
    const offline = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const keys = keyTester([], offline);

    const result = await guided(scriptedPrompt(["offline-key", "s"]), { matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Could not reach Jev (ENOTFOUND). Check your network connection.");
    expect(read(apiKeyPath(sandbox.env)).trim()).toBe("offline-key");
    expect(existsSync(databasePath(sandbox.env))).toBe(true);
  });

  it("changes nothing in the settings or rules file when run again", async () => {
    const env = { TYPESAFE_API_KEY: "good-key" };
    await guided(scriptedPrompt([]), { env });
    const settingsBefore = read(settingsPath);
    const rulesBefore = read(rulesPath);
    const skillBefore = read(skillPath(sandbox.env));

    const result = await guided(scriptedPrompt([]), { env });

    expect(result.stdout).toContain("already in place");
    expect(read(settingsPath)).toBe(settingsBefore);
    expect(read(rulesPath)).toBe(rulesBefore);
    expect(read(skillPath(sandbox.env))).toBe(skillBefore);
  });
});

describe("install that asks nothing", () => {
  it("asks nothing when its input is not a terminal", async () => {
    const keys = keyTester(["good-key"]);

    const result = await guided(scriptedPrompt([]), { isTerminal: false, openPrompt: noPrompt, matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(keys.triedKeys).toEqual([]);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(apiKeyPath(sandbox.env))).toBe(false);
  });

  it("asks nothing in a terminal when given --yes", async () => {
    const keys = keyTester(["good-key"]);

    const result = await guided(scriptedPrompt([]), { args: ["--yes"], openPrompt: noPrompt, matcherFor: keys.matcherFor });

    expect(result.code).toBe(0);
    expect(keys.triedKeys).toEqual([]);
    expect(read(rulesPath)).toBe(AUTHORITY_LINE + "\n");
    expect(existsSync(skillPath(sandbox.env))).toBe(true);
  });
});

it("tells the user plainly when Node is too old, and changes nothing", async () => {
  const result = await guided(scriptedPrompt([]), { nodeVersion: "22.18.0", openPrompt: noPrompt });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Sally needs Node 24 or later, and this is Node 22.18.0.");
  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(databasePath(sandbox.env))).toBe(false);
});

it("uninstall leaves the key and the database and says where they are", async () => {
  await guided(scriptedPrompt(["good-key"]));

  const result = uninstallNow();

  expect(result.code).toBe(0);
  expect(read(apiKeyPath(sandbox.env)).trim()).toBe("good-key");
  expect(existsSync(databasePath(sandbox.env))).toBe(true);
  expect(result.stdout).toContain(`Your API key is still at ${apiKeyPath(sandbox.env)}.`);
  expect(result.stdout).toContain(databasePath(sandbox.env));
  expect(JSON.parse(read(settingsPath))).toEqual({});
});
