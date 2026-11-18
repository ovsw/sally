import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewPassage } from "../src/import.ts";
import { RuleError } from "../src/rules.ts";
import { gitRepo } from "./support/git.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

/** Writes an invented rules file at `path` and returns the path. */
function rulesFile(path: string, text = "# Rules\n\nAlways answer briefly.\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** The global rules file, in the sandbox's Claude Code folder. */
const globalFile = () => rulesFile(join(sandbox.root, ".claude", "CLAUDE.md"));

const becomesRule = (name: string, extra: Partial<NewPassage> = {}): NewPassage => ({
  text: `When ${name} comes up, do the ${name} thing.`,
  verdict: "becomes_rule",
  reason: `Only some turns are about ${name}, so a condition can pick them out.`,
  rules: [{ name, instruction: `Do the ${name} thing.`, conditions: [`The message is about ${name}.`] }],
  ...extra,
});

const alwaysRule: NewPassage = {
  text: "Answer in plain words.",
  verdict: "always_rule",
  reason: "It applies on every turn, so it stays in the rules file.",
};

const tooVague: NewPassage = {
  text: "Be careful.",
  verdict: "too_vague",
  reason: "No message could be checked against it.",
};

describe("starting an import", () => {
  it("gives the global rules file's rules to all projects", () => {
    const file = globalFile();
    const started = sandbox.withImports((imports) => imports.startImport(file));
    expect(started).toMatchObject({
      rulesFile: file,
      scope: { kind: "all" },
      removedAt: null,
      passageCount: 0,
      pendingCount: 0,
    });
  });

  it("gives a rules file in the user's rules folder to all projects, even when it is a link", () => {
    const real = rulesFile(join(sandbox.root, "dotfiles", "style.md"));
    mkdirSync(join(sandbox.root, ".claude", "rules"), { recursive: true });
    const linked = join(sandbox.root, ".claude", "rules", "style.md");
    symlinkSync(real, linked);
    expect(sandbox.withImports((imports) => imports.startImport(linked))).toMatchObject({
      rulesFile: linked,
      scope: { kind: "all" },
    });
  });

  it("gives the global rules file to all projects when the Claude Code folder is a link", () => {
    rulesFile(join(sandbox.root, "dotfiles", "claude", "CLAUDE.md"));
    symlinkSync(join(sandbox.root, "dotfiles", "claude"), join(sandbox.root, ".claude"));
    const real = join(sandbox.root, "dotfiles", "claude", "CLAUDE.md");
    expect(sandbox.withImports((imports) => imports.startImport(real)).scope).toEqual({ kind: "all" });
  });

  it("gives a project's rules file to that project, and records the project", () => {
    const repo = gitRepo(join(sandbox.root, "work", "shop"), { origin: "git@github.com:Example/Shop.git" });
    const file = rulesFile(join(repo, "CLAUDE.md"));
    const started = sandbox.withImports((imports) => imports.startImport(file));
    expect(started.scope).toEqual({ kind: "projects", projects: ["example/shop"] });
    expect(sandbox.withRules((rules) => rules.projects()).map((p) => p.name)).toContain("example/shop");
  });

  it("gives a rules file in a folder below the project to the same project", () => {
    const repo = gitRepo(join(sandbox.root, "work", "shop"), { origin: "https://github.com/example/shop" });
    const file = rulesFile(join(repo, "packages", "api", "CLAUDE.md"));
    const started = sandbox.withImports((imports) => imports.startImport(file));
    expect(started.scope).toEqual({ kind: "projects", projects: ["example/shop"] });
  });

  it("gives a rules file in the .claude folder of a project outside git to the project's folder", () => {
    const project = join(sandbox.root, "notes");
    const inside = rulesFile(join(project, ".claude", "rules", "style.md"));
    const main = rulesFile(join(project, ".claude", "CLAUDE.md"));
    for (const file of [inside, main]) {
      expect(sandbox.withImports((imports) => imports.startImport(file)).scope).toEqual({
        kind: "projects",
        projects: [project],
      });
    }
  });

  it("refuses a path with no file", () => {
    expect(() => sandbox.withImports((imports) => imports.startImport(join(sandbox.root, "nothing.md")))).toThrow(
      RuleError,
    );
    expect(sandbox.query("SELECT id FROM imports")).toEqual([]);
  });

  it("starts fresh each time, keeping no memory of an earlier import of the same file", () => {
    const file = globalFile();
    const first = sandbox.withImports((imports) => imports.startImport(file));
    sandbox.withImports((imports) => imports.addPassages(first.id, [alwaysRule]));
    const second = sandbox.withImports((imports) => imports.startImport(file));
    expect(second.id).not.toBe(first.id);
    expect(second.passageCount).toBe(0);
    expect(sandbox.withImports((imports) => imports.listImports()).map((i) => i.id)).toEqual([second.id, first.id]);
  });
});

describe("adding passages", () => {
  it("keeps each passage's text, verdict, reason and position in the file", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const multiLine = "## Links\n\nWhen a page changes:\n- give the local link\n- wait for an OK\n";
    const detail = sandbox.withImports((imports) =>
      imports.addPassages(id, [becomesRule("Links", { text: multiLine }), alwaysRule, tooVague]),
    );
    expect(detail.passages.map((p) => [p.position, p.text, p.verdict, p.reason])).toEqual([
      [1, multiLine, "becomes_rule", "Only some turns are about Links, so a condition can pick them out."],
      [2, "Answer in plain words.", "always_rule", "It applies on every turn, so it stays in the rules file."],
      [3, "Be careful.", "too_vague", "No message could be checked against it."],
    ]);
    expect(detail.passages.map((p) => p.decision)).toEqual([null, null, null]);
  });

  it("adds later passages after the earlier ones", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    sandbox.withImports((imports) => imports.addPassages(id, [alwaysRule]));
    const detail = sandbox.withImports((imports) => imports.addPassages(id, [tooVague, becomesRule("Links")]));
    expect(detail.passages.map((p) => [p.position, p.verdict])).toEqual([
      [1, "always_rule"],
      [2, "too_vague"],
      [3, "becomes_rule"],
    ]);
  });

  it("creates each proposed rule as a draft, linked to its passage, with the rules file's scope", () => {
    const repo = gitRepo(join(sandbox.root, "work", "shop"), { origin: "git@github.com:example/shop.git" });
    const { id } = sandbox.withImports((imports) => imports.startImport(rulesFile(join(repo, "CLAUDE.md"))));
    const [passage] = sandbox.withImports((imports) => imports.addPassages(id, [becomesRule("Links")])).passages;

    expect(passage!.rules).toHaveLength(1);
    const [proposed] = passage!.rules;
    expect(proposed).toMatchObject({ decision: null, rule: { name: "Links", state: "draft", live: null } });
    expect(proposed!.rule!.draft).toMatchObject({
      instruction: "Do the Links thing.",
      conditions: ["The message is about Links."],
      checkType: "message",
      scope: { kind: "projects", projects: ["example/shop"] },
    });
    // The draft is an ordinary rule: the rules list shows it.
    expect(sandbox.withRules((rules) => rules.listRules()).map((r) => [r.id, r.state])).toEqual([
      [proposed!.ruleId, "draft"],
    ]);
  });

  it("lets one passage produce several rules, in order", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const passage: NewPassage = {
      text: "Before a commit run the linter; before a release run the full suite.",
      verdict: "becomes_rule",
      reason: "Two situations, so two rules, each with its own condition.",
      similarRule: "Looks like your rule \"Checks\".",
      rules: [
        { name: "Lint before commit", instruction: "Run the linter.", conditions: ["The message asks to commit."] },
        {
          name: "Suite before release",
          checkType: "reply",
          instruction: "Run the full suite.",
          conditions: ["The reply says a release is ready."],
        },
      ],
    };
    const [view] = sandbox.withImports((imports) => imports.addPassages(id, [passage])).passages;
    expect(view!.similarRule).toBe("Looks like your rule \"Checks\".");
    expect(view!.rules.map((r) => [r.rule!.name, r.rule!.checkType])).toEqual([
      ["Lint before commit", "message"],
      ["Suite before release", "reply"],
    ]);
  });

  it("refuses a passage that becomes a rule without one, or stays with one, or has no known verdict", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const add = (passage: NewPassage) => () => sandbox.withImports((imports) => imports.addPassages(id, [passage]));
    expect(add({ ...becomesRule("Links"), rules: [] })).toThrow(/needs at least one proposed rule/);
    expect(add({ ...alwaysRule, rules: becomesRule("Links").rules })).toThrow(/proposes no rules/);
    expect(add({ ...alwaysRule, verdict: "maybe" as never })).toThrow(/verdict is one of/);
    expect(add({ ...alwaysRule, reason: " " })).toThrow(/reason needs text/);
  });

  it("adds all the passages or none: a rule that cannot be created leaves nothing behind", () => {
    sandbox.liveRule({ name: "Links" });
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    expect(() =>
      sandbox.withImports((imports) => imports.addPassages(id, [becomesRule("Tables"), alwaysRule, becomesRule("Links")])),
    ).toThrow(/Passage 3, rule 1: .*Links/);
    expect(sandbox.withImports((imports) => imports.getImport(id)).passageCount).toBe(0);
    expect(sandbox.withRules((rules) => rules.listRules()).map((r) => r.name)).toEqual(["Links"]);
  });

  it("refuses an import that does not exist", () => {
    expect(() => sandbox.withImports((imports) => imports.addPassages(99, [alwaysRule]))).toThrow(/No import with id 99/);
  });
});

describe("pending passages", () => {
  it("counts every passage as pending until the user acts on it", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const detail = sandbox.withImports((imports) => imports.addPassages(id, [becomesRule("Links"), alwaysRule]));
    expect(detail.passages.map((p) => p.pending)).toEqual([true, true]);
    expect(detail.pendingCount).toBe(2);
  });

  it("publishing a passage's only rule makes it live and the passage no longer pending", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const [passage] = sandbox.withImports((imports) => imports.addPassages(id, [becomesRule("Links")])).passages;
    sandbox.withRules((rules) => rules.publish(passage!.rules[0]!.ruleId!));

    const after = sandbox.withImports((imports) => imports.getImport(id));
    expect(after.passages[0]!.rules[0]).toMatchObject({ decision: "published", rule: { state: "live" } });
    expect(after.passages[0]!.pending).toBe(false);
    expect(after.pendingCount).toBe(0);
    expect(sandbox.withRules((rules) => rules.liveRules("message")).map((r) => r.name)).toEqual(["Links"]);
  });

  it("keeps a passage pending while any of its rules is undecided", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const passage: NewPassage = {
      ...becomesRule("Links"),
      rules: [
        { name: "One", instruction: "Do one.", conditions: ["One applies."] },
        { name: "Two", instruction: "Do two.", conditions: ["Two applies."] },
      ],
    };
    const [view] = sandbox.withImports((imports) => imports.addPassages(id, [passage])).passages;
    sandbox.withRules((rules) => rules.publish(view!.rules[0]!.ruleId!));
    const after = sandbox.withImports((imports) => imports.getImport(id)).passages[0]!;
    expect(after.rules.map((r) => r.decision)).toEqual(["published", null]);
    expect(after.pending).toBe(true);
  });

  it("shows a proposed rule deleted from the rules screen as skipped", () => {
    const { id } = sandbox.withImports((imports) => imports.startImport(globalFile()));
    const [view] = sandbox.withImports((imports) => imports.addPassages(id, [becomesRule("Links")])).passages;
    sandbox.withRules((rules) => rules.deleteRule(view!.rules[0]!.ruleId!));
    const after = sandbox.withImports((imports) => imports.getImport(id)).passages[0]!;
    expect(after.rules).toEqual([{ id: view!.rules[0]!.id, ruleId: null, decision: "skipped", rule: null }]);
    expect(after.pending).toBe(false);
  });
});
