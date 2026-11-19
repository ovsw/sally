import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewPassage } from "../src/import.ts";
import { conditionsFor, RuleError } from "../src/rules.ts";
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

  // A file link needs a privilege Windows gives only to administrators or in Developer Mode.
  it.skipIf(process.platform === "win32")(
    "gives a rules file in the user's rules folder to all projects, even when it is a link",
    () => {
      const real = rulesFile(join(sandbox.root, "dotfiles", "style.md"));
      mkdirSync(join(sandbox.root, ".claude", "rules"), { recursive: true });
      const linked = join(sandbox.root, ".claude", "rules", "style.md");
      symlinkSync(real, linked);
      expect(sandbox.withImports((imports) => imports.startImport(linked))).toMatchObject({
        rulesFile: linked,
        scope: { kind: "all" },
      });
    },
  );

  it("gives the global rules file to all projects when the Claude Code folder is a link", () => {
    rulesFile(join(sandbox.root, "dotfiles", "claude", "CLAUDE.md"));
    // A junction on Windows, which needs no privilege; elsewhere the type is ignored.
    symlinkSync(join(sandbox.root, "dotfiles", "claude"), join(sandbox.root, ".claude"), "junction");
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
    expect(proposed).toMatchObject({ decision: null, rule: { name: "Links", published: false, live: null } });
    expect(proposed!.rule!.draft).toMatchObject({
      instruction: "Do the Links thing.",
      conditions: [{ text: "The message is about Links.", message: true, reply: false }],
      scope: { kind: "projects", projects: ["example/shop"] },
    });
    // The draft is an ordinary rule: the rules list shows it.
    expect(sandbox.withRules((rules) => rules.listRules()).map((r) => [r.id, r.published])).toEqual([
      [proposed!.ruleId, false],
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
    expect(view!.rules.map((r) => [r.rule!.name, r.rule!.checkTypes])).toEqual([
      ["Lint before commit", ["message"]],
      ["Suite before release", ["reply"]],
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
    expect(after.passages[0]!.rules[0]).toMatchObject({ decision: "published", rule: { published: true } });
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

describe("decisions", () => {
  const twoRules: NewPassage = {
    ...becomesRule("Links"),
    rules: [
      { name: "One", instruction: "Do one.", conditions: ["One applies."] },
      { name: "Two", instruction: "Do two.", conditions: ["Two applies."] },
      { name: "Three", instruction: "Do three.", conditions: ["Three applies."] },
    ],
  };

  /** Starts an import of the global rules file with these passages and returns it. */
  const importOf = (...passages: NewPassage[]) =>
    sandbox.withImports((imports) => imports.addPassages(imports.startImport(globalFile()).id, passages));

  const ruleNames = () => sandbox.withRules((rules) => rules.listRules()).map((r) => r.name);

  it("publishes an edited proposed rule with the edits", () => {
    const [passage] = importOf(becomesRule("Links")).passages;
    const proposed = passage!.rules[0]!;
    sandbox.withRules((rules) =>
      rules.saveDraft(proposed.ruleId!, { instruction: "Give the local link.", conditions: conditionsFor("message", ["The message asks for a link."]) }),
    );
    const after = sandbox.withImports((imports) => imports.publishProposedRule(proposed.id));
    expect(after.passages[0]!.rules[0]).toMatchObject({
      decision: "published",
      rule: { published: true, live: { instruction: "Give the local link.", conditions: [{ text: "The message asks for a link." }] } },
    });
    expect(after.passages[0]!.pending).toBe(false);
  });

  it("refuses to publish a proposed rule that is not complete, leaving it undecided", () => {
    const detail = importOf(becomesRule("Links"));
    const proposed = detail.passages[0]!.rules[0]!;
    sandbox.withRules((rules) => rules.saveDraft(proposed.ruleId!, { instruction: "", conditions: conditionsFor("message", []) }));
    expect(() => sandbox.withImports((imports) => imports.publishProposedRule(proposed.id))).toThrow(RuleError);
    expect(sandbox.withImports((imports) => imports.getImport(detail.id)).passages[0]!.rules[0]!.decision).toBeNull();
  });

  it("keeps a proposed rule as a draft, settling it, and can publish it later", () => {
    const detail = importOf(becomesRule("Links"));
    const proposed = detail.passages[0]!.rules[0]!;
    const kept = sandbox.withImports((imports) => imports.keepProposedRule(proposed.id));
    expect(kept.passages[0]!.rules[0]).toMatchObject({ decision: "kept", rule: { published: false } });
    expect(kept.passages[0]!.pending).toBe(false);
    expect(kept.pendingCount).toBe(0);
    expect(sandbox.withRules((rules) => rules.liveRules("message"))).toEqual([]);

    const published = sandbox.withImports((imports) => imports.publishProposedRule(proposed.id));
    expect(published.passages[0]!.rules[0]!.decision).toBe("published");
  });

  it("skips a proposed rule by deleting its draft, settling it for good", () => {
    const detail = importOf(becomesRule("Links"));
    const proposed = detail.passages[0]!.rules[0]!;
    const skipped = sandbox.withImports((imports) => imports.skipProposedRule(proposed.id));
    expect(skipped.passages[0]!.rules[0]).toEqual({ id: proposed.id, ruleId: null, decision: "skipped", rule: null });
    expect(skipped.passages[0]!.pending).toBe(false);
    expect(ruleNames()).toEqual([]);

    expect(() => sandbox.withImports((imports) => imports.keepProposedRule(proposed.id))).toThrow(/Write a new rule/);
    expect(() => sandbox.withImports((imports) => imports.publishProposedRule(proposed.id))).toThrow(/Write a new rule/);
    expect(sandbox.withImports((imports) => imports.skipProposedRule(proposed.id)).passages[0]!.rules[0]!.decision).toBe(
      "skipped",
    );
  });

  it("skips a rule that was kept as a draft", () => {
    const proposed = importOf(becomesRule("Links")).passages[0]!.rules[0]!;
    sandbox.withImports((imports) => imports.keepProposedRule(proposed.id));
    const skipped = sandbox.withImports((imports) => imports.skipProposedRule(proposed.id));
    expect(skipped.passages[0]!.rules[0]!.decision).toBe("skipped");
    expect(ruleNames()).toEqual([]);
  });

  it("refuses to keep or skip a published rule", () => {
    const proposed = importOf(becomesRule("Links")).passages[0]!.rules[0]!;
    sandbox.withImports((imports) => imports.publishProposedRule(proposed.id));
    expect(() => sandbox.withImports((imports) => imports.keepProposedRule(proposed.id))).toThrow(/published/);
    expect(() => sandbox.withImports((imports) => imports.skipProposedRule(proposed.id))).toThrow(/published/);
    expect(ruleNames()).toEqual(["Links"]);
  });

  it("decides each of a passage's rules on its own, pending until the last is settled", () => {
    const [passage] = importOf(twoRules).passages;
    const [one, two, three] = passage!.rules;
    sandbox.withImports((imports) => imports.publishProposedRule(one!.id));
    const afterKeep = sandbox.withImports((imports) => imports.keepProposedRule(two!.id));
    expect(afterKeep.passages[0]!.rules.map((r) => r.decision)).toEqual(["published", "kept", null]);
    expect(afterKeep.passages[0]!.pending).toBe(true);

    const done = sandbox.withImports((imports) => imports.skipProposedRule(three!.id));
    expect(done.passages[0]!.rules.map((r) => r.decision)).toEqual(["published", "kept", "skipped"]);
    expect(done.passages[0]!.pending).toBe(false);
    expect(ruleNames()).toEqual(["One", "Two"]);
  });

  it("shows passages that stay with their reason, pending until seen", () => {
    const detail = importOf(alwaysRule, tooVague);
    expect(detail.passages.map((p) => [p.verdict, p.reason, p.pending])).toEqual([
      ["always_rule", alwaysRule.reason, true],
      ["too_vague", tooVague.reason, true],
    ]);
    const seen = sandbox.withImports((imports) => imports.markPassageSeen(detail.passages[0]!.id));
    expect(seen.passages.map((p) => p.pending)).toEqual([false, true]);
    expect(seen.passages[0]!.seenAt).not.toBeNull();
    expect(seen.pendingCount).toBe(1);
  });

  it("seeing a passage that becomes a rule does not settle it", () => {
    const detail = importOf(becomesRule("Links"));
    const seen = sandbox.withImports((imports) => imports.markPassageSeen(detail.passages[0]!.id));
    expect(seen.passages[0]!.pending).toBe(true);
  });

  it("writes a rule for a passage that was to stay, with the import's scope, pending until it is settled", () => {
    const detail = importOf(alwaysRule);
    const passage = detail.passages[0]!;
    sandbox.withImports((imports) => imports.markPassageSeen(passage.id));
    const written = sandbox.withImports((imports) =>
      imports.writeRule(passage.id, {
        name: "Plain words",
        instruction: "Rewrite the reply in plain words.",
        conditions: conditionsFor("reply", ["The reply uses jargon."]),
      }),
    );
    const after = written.passages[0]!;
    expect(after.decision).toBe("becomes_rule");
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0]).toMatchObject({
      decision: null,
      rule: { name: "Plain words", checkTypes: ["reply"], published: false, draft: { scope: { kind: "all" } } },
    });
    expect(after.pending).toBe(true);

    const published = sandbox.withImports((imports) => imports.publishProposedRule(after.rules[0]!.id));
    expect(published.passages[0]!.pending).toBe(false);
  });

  it("writes a new rule for a passage whose proposed rule was skipped, after it", () => {
    const proposed = importOf(becomesRule("Links")).passages[0]!.rules[0]!;
    const skipped = sandbox.withImports((imports) => imports.skipProposedRule(proposed.id));
    const written = sandbox.withImports((imports) =>
      imports.writeRule(skipped.passages[0]!.id, {
        name: "Links again",
        instruction: "Give the link.",
        conditions: conditionsFor("message", ["The message asks for a link."]),
      }),
    );
    expect(written.passages[0]!.decision).toBeNull();
    expect(written.passages[0]!.rules.map((r) => r.decision)).toEqual(["skipped", null]);
    expect(written.passages[0]!.pending).toBe(true);
  });

  it("refuses to write a rule that is not complete or whose name is taken", () => {
    const detail = importOf(alwaysRule);
    const passage = detail.passages[0]!;
    sandbox.liveRule({ name: "Taken" });
    const write = (name: string, instruction: string) =>
      sandbox.withImports((imports) =>
        imports.writeRule(passage.id, { name, instruction, conditions: conditionsFor("message", ["The message asks."]) }),
      );
    expect(() => write("New", "")).toThrow(RuleError);
    expect(() => write("Taken", "Do it.")).toThrow(RuleError);
    const after = sandbox.withImports((imports) => imports.getImport(detail.id)).passages[0]!;
    expect(after.decision).toBeNull();
    expect(after.rules).toEqual([]);
  });

  it("marks a passage as staying, skipping its rules not yet published, including kept drafts", () => {
    const [passage] = importOf(twoRules).passages;
    sandbox.withImports((imports) => imports.keepProposedRule(passage!.rules[0]!.id));
    const stays = sandbox.withImports((imports) => imports.markPassageStays(passage!.id));
    expect(stays.passages[0]!).toMatchObject({ decision: "stays", pending: false });
    expect(stays.passages[0]!.seenAt).not.toBeNull();
    expect(stays.passages[0]!.rules.map((r) => r.decision)).toEqual(["skipped", "skipped", "skipped"]);
    expect(ruleNames()).toEqual([]);
  });

  it("refuses to mark a passage as staying while one of its rules is published", () => {
    const [passage] = importOf(twoRules).passages;
    sandbox.withImports((imports) => imports.publishProposedRule(passage!.rules[0]!.id));
    expect(() => sandbox.withImports((imports) => imports.markPassageStays(passage!.id))).toThrow(/published/);
    expect(ruleNames()).toEqual(["One", "Three", "Two"]);
  });

  it("lets a passage marked as staying become a rule again by writing one", () => {
    const [passage] = importOf(becomesRule("Links")).passages;
    sandbox.withImports((imports) => imports.markPassageStays(passage!.id));
    const written = sandbox.withImports((imports) =>
      imports.writeRule(passage!.id, { name: "Links", instruction: "Do it.", conditions: conditionsFor("message", ["Links come up."]) }),
    );
    expect(written.passages[0]!.decision).toBe("becomes_rule");
    expect(written.passages[0]!.rules.map((r) => r.decision)).toEqual(["skipped", null]);
  });

  it("refuses decisions on a passage or proposed rule that does not exist", () => {
    expect(() => sandbox.withImports((imports) => imports.markPassageSeen(999))).toThrow(/No passage/);
    expect(() => sandbox.withImports((imports) => imports.keepProposedRule(999))).toThrow(/No proposed rule/);
  });
});
