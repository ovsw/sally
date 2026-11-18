import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImportDetail, ImportSummary } from "../src/import.ts";
import type { RemovalReport } from "../src/import-removal.ts";
import { gitRepo } from "./support/git.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

// Runs the real command with only the sandbox's environment, so it never
// touches the user's database or rules files.
function sally(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [cli, "import", ...args], {
    input,
    encoding: "utf8",
    env: sandbox.childEnv(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sallyJson<T>(args: string[], input?: string): T {
  const result = sally(args, input);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as T;
}

function globalFile(): string {
  const path = join(sandbox.root, ".claude", "CLAUDE.md");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "# Rules\n\nAnswer briefly.\n");
  return path;
}

// Multi-line text with quotes and a code block, as an agent would send it.
const PASSAGES = [
  {
    text: '## Screenshots\n\nWhen a page changes, take a screenshot:\n\n```sh\nshoot --full "page"\n```\n',
    verdict: "becomes_rule",
    reason: "It applies only when a page changes, so a condition can tell when.",
    rules: [
      {
        name: "Screenshot changed pages",
        instruction: "Take a full-page screenshot of the changed page.",
        conditions: ["The reply says a page's layout changed."],
        checkType: "reply",
      },
    ],
  },
  { text: "Answer briefly.", verdict: "always_rule", reason: "It applies on every turn." },
];

describe("import start", () => {
  it("starts an import for a rules file and prints it as JSON", () => {
    const file = globalFile();
    const started = sallyJson<ImportSummary>(["start", file]);
    expect(started).toMatchObject({ id: 1, rulesFile: file, scope: { kind: "all" }, passageCount: 0, pendingCount: 0 });
  });

  it("scopes a project's rules file to that project", () => {
    const repo = gitRepo(join(sandbox.root, "work", "shop"), { origin: "git@github.com:example/shop.git" });
    writeFileSync(join(repo, "CLAUDE.md"), "Use the shop's own words.\n");
    expect(sallyJson<ImportSummary>(["start", join(repo, "CLAUDE.md")]).scope).toEqual({
      kind: "projects",
      projects: ["example/shop"],
    });
  });

  it("refuses a missing rules file, changing nothing", () => {
    const result = sally(["start", join(sandbox.root, "missing.md")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/There is no rules file at/);
    expect(result.stdout).toBe("");
  });

  it("refuses without a rules file, with the usage", () => {
    const result = sally(["start"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/takes one rules file/);
    expect(result.stderr).toMatch(/Usage:/);
  });
});

describe("import add", () => {
  it("reads passages from standard input and adds them with their proposed rules as drafts", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const detail = sallyJson<ImportDetail>(["add", String(id)], JSON.stringify(PASSAGES));
    expect(detail.passages.map((p) => [p.position, p.text, p.verdict])).toEqual([
      [1, PASSAGES[0]!.text, "becomes_rule"],
      [2, "Answer briefly.", "always_rule"],
    ]);
    expect(detail.passages[0]!.rules[0]!.rule).toMatchObject({
      name: "Screenshot changed pages",
      checkType: "reply",
      state: "draft",
    });
    expect(detail.pendingCount).toBe(2);
  });

  it("reads passages from a file, as a list or under \"passages\"", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const file = join(sandbox.root, "passages.json");
    writeFileSync(file, JSON.stringify({ passages: [PASSAGES[1]] }));
    sallyJson(["add", String(id), "--file", file]);
    writeFileSync(file, JSON.stringify([PASSAGES[0]]));
    const detail = sallyJson<ImportDetail>(["add", String(id), "--file", file]);
    expect(detail.passages.map((p) => p.verdict)).toEqual(["always_rule", "becomes_rule"]);
  });

  it("show prints the import with its passages; list prints every import", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    sallyJson(["add", String(id)], JSON.stringify(PASSAGES));
    expect(sallyJson<ImportDetail>(["show", String(id)]).passages).toHaveLength(2);
    expect(sallyJson<{ imports: ImportSummary[] }>(["list"]).imports.map((i) => [i.id, i.passageCount])).toEqual([
      [id, 2],
    ]);
  });

  it("refuses JSON that is not valid, or not a list of passages, changing nothing", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const broken = sally(["add", String(id)], "[{ not json");
    expect(broken.status).toBe(1);
    expect(broken.stderr).toMatch(/not valid JSON/);
    const notList = sally(["add", String(id)], JSON.stringify({ text: "Hello" }));
    expect(notList.status).toBe(1);
    expect(notList.stderr).toMatch(/must be a JSON list/);
    expect(sandbox.query("SELECT id FROM passages")).toEqual([]);
  });

  it("refuses a bad passage and says which, adding none of them", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const bad = [PASSAGES[1], { ...PASSAGES[0], rules: [] }];
    const result = sally(["add", String(id)], JSON.stringify(bad));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Passage 2 becomes a rule, so it needs at least one proposed rule.\n");
    expect(sandbox.query("SELECT id FROM passages")).toEqual([]);
    expect(sandbox.query("SELECT id FROM rules")).toEqual([]);
  });

  it("refuses an import that does not exist, or an id that is not one", () => {
    expect(sally(["add", "7"], JSON.stringify(PASSAGES)).stderr).toBe("No import with id 7.\n");
    expect(sally(["add", "seven"], "[]").stderr).toMatch(/An import's id is a whole number/);
  });
});

// A passage that bundles two situations, so it proposes two rules.
const BUNDLED = {
  text: "Before a release, run the tests. After a release, post the notes.",
  verdict: "becomes_rule",
  reason: "Two situations, so two rules, each with its own condition.",
  rules: [
    { name: "Test before release", instruction: "Run the tests first.", conditions: ["The user asks to release."] },
    { name: "Notes after release", instruction: "Post the release notes.", conditions: ["The reply says a release went out."] },
  ],
};

describe("import show, for the removal", () => {
  it("reports each passage's decisions, which rules are live, and what to remove", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const added = sallyJson<ImportDetail>(["add", String(id)], JSON.stringify([...PASSAGES, BUNDLED]));
    const [screenshot, , bundled] = added.passages;
    // The user publishes the screenshot rule and one of the two bundled rules in the web app.
    sandbox.withRules((rules) => {
      rules.publish(screenshot!.rules[0]!.ruleId!);
      rules.publish(bundled!.rules[1]!.ruleId!);
    });

    const shown = sallyJson<RemovalReport>(["show", String(id)]);
    expect(shown).toMatchObject({ id, removedAt: null, removeAll: [1], removePart: [3] });
    expect(shown.passages.map((p) => [p.position, p.stays, p.removal])).toEqual([
      [1, false, "all"],
      [2, true, "none"],
      [3, false, "part"],
    ]);
    expect(shown.passages[2]!.rules.map((r) => [r.name, r.decision, r.live])).toEqual([
      ["Test before release", null, false],
      ["Notes after release", "published", true],
    ]);
    expect(shown.passages[0]!.rules[0]).toMatchObject({
      instruction: "Take a full-page screenshot of the changed page.",
      conditions: ["The reply says a page's layout changed."],
    });
  });

  it("leaves a passage in the file while its published rule is switched off", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const added = sallyJson<ImportDetail>(["add", String(id)], JSON.stringify([...PASSAGES, BUNDLED]));
    const [screenshot, , bundled] = added.passages;
    sandbox.withRules((rules) => {
      rules.publish(screenshot!.rules[0]!.ruleId!);
      rules.switchOff(screenshot!.rules[0]!.ruleId!);
      for (const proposal of bundled!.rules) rules.publish(proposal.ruleId!);
      rules.switchOff(bundled!.rules[0]!.ruleId!);
    });

    const shown = sallyJson<RemovalReport>(["show", String(id)]);
    // The hooks skip a switched-off rule, so its passage is still what does the work.
    expect(shown).toMatchObject({ removeAll: [], removePart: [3] });
    expect(shown.passages[0]!.rules[0]).toMatchObject({ decision: "published", live: true, on: false });
  });

  it("refuses an import that does not exist", () => {
    const result = sally(["show", "9"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("No import with id 9.\n");
  });
});

describe("import backup", () => {
  it("copies the rules file into the data folder under a dated name and prints the path", () => {
    const file = globalFile();
    const { rulesFile, backup } = sallyJson<{ rulesFile: string; backup: string }>(["backup", file]);
    expect(rulesFile).toBe(file);
    expect(backup.startsWith(join(sandbox.env.SALLY_DATA_DIR!, "backups"))).toBe(true);
    expect(backup).toMatch(/\d{4}-\d{2}-\d{2}-\.claude-CLAUDE\.md$/);
    expect(readFileSync(backup, "utf8")).toBe(readFileSync(file, "utf8"));
    // Nothing is written beside the rules file.
    expect(readdirSync(join(file, ".."))).toEqual(["CLAUDE.md"]);
  });

  it("never overwrites an earlier backup of the same file on the same day", () => {
    const file = globalFile();
    const first = sallyJson<{ backup: string }>(["backup", file]).backup;
    writeFileSync(file, "# Rules\n\nChanged since.\n");
    const second = sallyJson<{ backup: string }>(["backup", file]).backup;
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("# Rules\n\nAnswer briefly.\n");
    expect(readFileSync(second, "utf8")).toBe("# Rules\n\nChanged since.\n");
  });

  it("refuses a missing file, or no file at all", () => {
    const missing = sally(["backup", join(sandbox.root, "nowhere.md")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe(`There is no rules file at ${join(sandbox.root, "nowhere.md")}.\n`);
    const none = sally(["backup"]);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/takes one rules file/);
  });
});

describe("import removed", () => {
  it("records that the removal happened, keeping the first time when recorded again", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const recorded = sallyJson<{ id: number; removedAt: string }>(["removed", String(id)]);
    expect(recorded.id).toBe(id);
    expect(sallyJson<RemovalReport>(["show", String(id)]).removedAt).toBe(recorded.removedAt);
    expect(sallyJson<{ removedAt: string }>(["removed", String(id)]).removedAt).toBe(recorded.removedAt);
    // An import whose removal happened takes no more passages.
    expect(sally(["add", String(id)], JSON.stringify(PASSAGES)).stderr).toMatch(/removal has happened/);
  });

  it("refuses an import that does not exist", () => {
    const result = sally(["removed", "4"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("No import with id 4.\n");
  });
});

describe("publishing", () => {
  it("cannot be done from the command line", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    sallyJson(["add", String(id)], JSON.stringify(PASSAGES));
    const result = sally(["publish", String(id)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/done by the user in Sally's web app/);
    expect(sandbox.query("SELECT id FROM versions WHERE number IS NOT NULL")).toEqual([]);
  });

  it("has no option to publish while adding", () => {
    const { id } = sallyJson<ImportSummary>(["start", globalFile()]);
    const result = sally(["add", String(id), "--publish"], JSON.stringify(PASSAGES));
    expect(result.status).toBe(1);
    expect(sandbox.query("SELECT id FROM rules")).toEqual([]);
  });
});

it("prints the usage for help, and refuses an unknown command", () => {
  expect(sally(["help"]).stdout).toMatch(/node src\/cli\.ts import start RULES_FILE/);
  const unknown = sally(["merge"]);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toMatch(/Unknown command "import merge"/);
});
