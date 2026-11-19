import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conditionsFor, type RuleDetail, type RuleSummary } from "../src/rules.ts";
import { startApp } from "./support/app.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

// Runs the real command with only the sandbox's environment, so it never
// touches the user's database.
function sally(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "rules", ...args], {
    encoding: "utf8",
    env: sandbox.childEnv(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sallyJson(...args: string[]) {
  const result = sally(...args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

/** A rule with a live version and, on top of it, a draft. */
function ruleWithDraft(): number {
  const ruleId = sandbox.liveRule({ name: "Links", instruction: "Give a local link.", conditions: ["The reply is visual."] });
  sandbox.withRules((rules) =>
    rules.saveDraft(ruleId, { instruction: "Give the localhost link.", conditions: conditionsFor("message", ["The reply reports a visual change."]) }),
  );
  return ruleId;
}

describe("reading rules", () => {
  it("lists every rule as JSON with its conditions in force, each with its two switches, and no check type", () => {
    const linksId = ruleWithDraft();
    const draftId = sandbox.withRules(
      (rules) =>
        rules.createRule({ name: "Brief", instruction: "Be brief.", conditions: conditionsFor("reply", ["The reply is long."]) })
          .ruleId,
    );
    const bothId = sandbox.liveRule({
      name: "Visual",
      instruction: "Give the localhost link.",
      conditions: [
        { text: "The message asks for a visual change.", message: true, reply: false },
        { text: "The reply gives no local link.", message: false, reply: true },
        { text: "The text is about a page's layout.", message: true, reply: true },
      ],
    });
    const common = { scope: { kind: "all" }, on: true, hasDraft: true };
    expect(sallyJson("list")).toEqual([
      {
        id: draftId,
        name: "Brief",
        published: false,
        ...common,
        instruction: "Be brief.",
        conditions: [{ id: expect.any(Number), text: "The reply is long.", message: false, reply: true }],
      },
      {
        id: linksId,
        name: "Links",
        published: true,
        ...common,
        // The published version's, not the draft's.
        instruction: "Give a local link.",
        conditions: [{ id: expect.any(Number), text: "The reply is visual.", message: true, reply: false }],
      },
      {
        id: bothId,
        name: "Visual",
        published: true,
        ...common,
        hasDraft: false,
        instruction: "Give the localhost link.",
        conditions: [
          { id: expect.any(Number), text: "The message asks for a visual change.", message: true, reply: false },
          { id: expect.any(Number), text: "The reply gives no local link.", message: false, reply: true },
          { id: expect.any(Number), text: "The text is about a page's layout.", message: true, reply: true },
        ],
      },
    ]);
  });

  it("narrows the list by search, check type, published, on and draft", () => {
    ruleWithDraft();
    sandbox.liveRule({ name: "Brief", checkType: "reply", instruction: "Be brief.", conditions: ["The reply is long."] });
    const names = (...args: string[]) => sallyJson("list", ...args).map((rule: { name: string }) => rule.name);
    expect(names("--search", "localhost")).toEqual(["Links"]);
    expect(names("--check-type", "reply")).toEqual(["Brief"]);
    sandbox.liveRule({ name: "Both", conditions: [{ text: "The text is about layout.", message: true, reply: true }] });
    expect(names("--check-type", "message")).toEqual(["Both", "Links"]);
    expect(names("--check-type", "reply")).toEqual(["Both", "Brief"]);
    expect(names("--unpublished")).toEqual([]);
    expect(names("--published", "--without-draft")).toEqual(["Both", "Brief"]);
    expect(names("--on")).toEqual(["Both", "Brief", "Links"]);
    expect(names("--off")).toEqual([]);
    expect(sally("list", "--on", "--off")).toMatchObject({ status: 1, stderr: expect.stringContaining("Use --on or --off, not both.") });
    expect(names("--with-draft")).toEqual(["Links"]);
    expect(names("--without-draft")).toEqual(["Both", "Brief"]);
  });

  it("shows one rule, by id or by name, with its live version beside its draft", () => {
    const ruleId = ruleWithDraft();
    const expected = {
      id: ruleId,
      name: "Links",
      published: true,
      hasDraft: true,
      live: {
        number: 1,
        name: "Links",
        instruction: "Give a local link.",
        conditions: [{ text: "The reply is visual.", message: true, reply: false }],
      },
      draft: {
        name: "Links",
        instruction: "Give the localhost link.",
        conditions: [{ text: "The reply reports a visual change.", message: true, reply: false }],
      },
    };
    expect(sallyJson("show", String(ruleId))).toMatchObject(expected);
    expect(sallyJson("show", "Links")).toMatchObject(expected);
    expect(sallyJson("show", "Links")).not.toHaveProperty("checkTypes");
  });

  it("fails clearly for a rule that does not exist", () => {
    expect(sally("show", "Nothing")).toMatchObject({ status: 1, stdout: "", stderr: 'No rule named "Nothing".\n' });
    expect(sally("show", "42")).toMatchObject({ status: 1, stdout: "", stderr: "No rule with id 42.\n" });
  });
});

describe("preparing drafts", () => {
  it("creates a rule as a draft that the engine does not use and the rules service shows", () => {
    const created = sallyJson(
      "create",
      "--name",
      "Links",
      "--check-type",
      "reply",
      "--instruction",
      "Give the localhost link.",
      "--condition",
      "The reply reports a visual change.",
      "--condition",
      "The reply hands back a page without a link.",
    );
    expect(created).toMatchObject({ name: "Links", published: false, hasDraft: true, live: null });
    expect(created).not.toHaveProperty("checkTypes");
    sandbox.withRules((rules) => {
      expect(rules.liveRules("reply")).toEqual([]);
      expect(rules.listRules()).toMatchObject([{ id: created.id, name: "Links", published: false, hasDraft: true }]);
      expect(rules.getRule(created.id).draft).toMatchObject({
        instruction: "Give the localhost link.",
        conditions: [
          { text: "The reply reports a visual change.", message: false, reply: true },
          { text: "The reply hands back a page without a link.", message: false, reply: true },
        ],
      });
    });
  });

  it("refuses to create a rule that is missing a part or takes a used name", () => {
    sandbox.liveRule({ name: "Links" });
    const missing = sally("create", "--name", "New", "--check-type", "message", "--instruction", "Do X.");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--condition");
    const taken = sally("create", "--name", "Links", "--check-type", "message", "--instruction", "Do X.", "--condition", "C.");
    expect(taken).toMatchObject({ status: 1, stderr: 'A rule named "Links" already exists.\n' });
    const badType = sally("create", "--name", "New", "--check-type", "tool", "--instruction", "Do X.", "--condition", "C.");
    expect(badType.status).toBe(1);
    expect(badType.stderr).toContain("--check-type is one of: message, reply.");
    sandbox.withRules((rules) => expect(rules.listRules().map((rule) => rule.name)).toEqual(["Links"]));
  });

  it("edits a live rule's name, instruction and conditions into a draft, new ones for the check given, leaving the live version alone", () => {
    const ruleId = sandbox.liveRule({ name: "Links", instruction: "Give a local link.", conditions: ["The reply is visual."] });
    const edited = sallyJson(
      "edit",
      "Links",
      "--name",
      "Local links",
      "--check-type",
      "reply",
      "--instruction",
      "Give the localhost link.",
      "--condition",
      "The reply reports a visual change.",
    );
    expect(edited).toMatchObject({
      id: ruleId,
      name: "Links",
      live: { name: "Links", instruction: "Give a local link.", conditions: [{ text: "The reply is visual.", message: true, reply: false }] },
      draft: {
        name: "Local links",
        instruction: "Give the localhost link.",
        conditions: [{ text: "The reply reports a visual change.", message: false, reply: true }],
      },
    });
    sandbox.withRules((rules) => {
      expect(rules.liveRules("message")).toMatchObject([{ ruleId, name: "Links", instruction: "Give a local link." }]);
      expect(rules.liveRules("reply")).toEqual([]);
      // The user publishes the agent's draft in the app; the engine then uses it.
      rules.publish(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.liveRules("reply")).toMatchObject([
        { ruleId, name: "Local links", instruction: "Give the localhost link.", versionNumber: 2 },
      ]);
    });
  });

  it("changes only the parts given and keeps the rest of the draft", () => {
    const ruleId = ruleWithDraft();
    const edited = sallyJson("edit", String(ruleId), "--instruction", "Always give the localhost link.");
    expect(edited.draft).toMatchObject({
      name: "Links",
      instruction: "Always give the localhost link.",
      conditions: [{ text: "The reply reports a visual change." }],
    });
    const renamed = sallyJson("edit", "Links", "--name", "Local links");
    expect(renamed.draft).toMatchObject({ name: "Local links", instruction: "Always give the localhost link." });
  });

  it("keeps a condition worded as before, and asks which check a new condition is for in a rule in both checks", () => {
    const ruleId = sandbox.liveRule({
      name: "Links",
      conditions: [
        { text: "The message asks for a visual change.", message: true, reply: false },
        { text: "The reply gives no local link.", message: false, reply: true },
      ],
    });
    const [kept] = sandbox.withRules((rules) => rules.getRule(ruleId).live!.conditions);
    const bothChecks = sally("edit", "Links", "--condition", "The message asks for a visual change.", "--condition", "New.");
    expect(bothChecks).toMatchObject({ status: 1, stderr: expect.stringContaining("--check-type") });
    const typeAlone = sally("edit", "Links", "--check-type", "reply");
    expect(typeAlone).toMatchObject({ status: 1, stderr: expect.stringContaining("needs --condition") });

    const edited = sallyJson(
      "edit",
      "Links",
      "--condition",
      "The message asks for a visual change.",
      "--condition",
      "The reply hands back a page.",
      "--check-type",
      "reply",
    );
    expect(edited.draft.conditions).toEqual([
      { id: kept!.id, text: "The message asks for a visual change.", message: true, reply: false },
      { id: expect.any(Number), text: "The reply hands back a page.", message: false, reply: true },
    ]);
  });

  it("puts a new condition in the check the draft is in, not the one the live version is in", () => {
    const ruleId = sandbox.liveRule({ name: "Links", conditions: ["The message asks for a visual change."] });
    sandbox.withRules((rules) =>
      rules.saveDraft(ruleId, { instruction: "Give a local link.", conditions: conditionsFor("reply", ["The reply gives no local link."]) }),
    );
    const edited = sallyJson("edit", "Links", "--condition", "The reply gives no local link.", "--condition", "The reply hands back a page.");
    expect(edited.draft.conditions).toMatchObject([
      { text: "The reply gives no local link.", message: false, reply: true },
      { text: "The reply hands back a page.", message: false, reply: true },
    ]);
  });

  it("refuses an edit that changes nothing or names another rule's name", () => {
    sandbox.liveRule({ name: "Links" });
    sandbox.liveRule({ name: "Brief" });
    const nothing = sally("edit", "Links");
    expect(nothing.status).toBe(1);
    expect(nothing.stderr).toContain("needs at least one of");
    expect(sally("edit", "Links", "--name", "Brief")).toMatchObject({
      status: 1,
      stderr: 'A rule named "Brief" already exists.\n',
    });
    sandbox.withRules((rules) => expect(rules.listRules({ hasDraft: true })).toEqual([]));
  });
});

describe("drafts in the app", () => {
  it("shows a rule created and edited here in the app, with the check its draft's conditions are on for", async () => {
    const created = sallyJson(
      "create",
      "--name",
      "Links",
      "--check-type",
      "message",
      "--instruction",
      "Give a local link.",
      "--condition",
      "The reply is visual.",
    );
    sallyJson(
      "edit",
      "Links",
      "--check-type",
      "reply",
      "--instruction",
      "Give the localhost link.",
      "--condition",
      "The reply reports a visual change.",
    );
    const app = await startApp(sandbox);
    try {
      const { rules } = await app.json<{ rules: RuleSummary[] }>("GET", "/api/rules?checkType=reply&hasDraft=true");
      expect(rules).toEqual([{ id: created.id, name: "Links", checkTypes: ["reply"], published: false, scope: { kind: "all" }, on: true, hasDraft: true }]);
      const rule = await app.json<RuleDetail>("GET", `/api/rules/${created.id}`);
      expect(rule).toMatchObject({
        live: null,
        draft: {
          name: "Links",
          instruction: "Give the localhost link.",
          conditions: [{ text: "The reply reports a visual change.", message: false, reply: true }],
        },
      });
      // The user publishes it in the app.
      const published = await app.json<{ versionNumber: number; rule: RuleDetail }>(
        "POST",
        `/api/rules/${created.id}/publish`,
        {},
      );
      expect(published).toMatchObject({ versionNumber: 1, rule: { published: true, checkTypes: ["reply"] } });
    } finally {
      await app.close();
    }
  });

  it("shows an agent's edit of a live rule as the draft beside the live version in the app", async () => {
    const ruleId = sandbox.liveRule({ name: "Links", instruction: "Give a local link.", conditions: ["The reply is visual."] });
    sallyJson("edit", "Links", "--name", "Local links");
    const app = await startApp(sandbox);
    try {
      expect(await app.json<RuleDetail>("GET", `/api/rules/${ruleId}`)).toMatchObject({
        name: "Links",
        published: true,
        hasDraft: true,
        live: { number: 1, name: "Links", instruction: "Give a local link." },
        draft: { name: "Local links", instruction: "Give a local link." },
      });
    } finally {
      await app.close();
    }
  });
});

describe("what stays with the user", () => {
  it.each([
    ["publish", "Publishing"],
    ["switch-off", "Switching off"],
    ["off", "Switching off"],
    ["delete", "Deleting"],
  ])("refuses to %s a rule, says why, and changes nothing", (command, action) => {
    const ruleId = ruleWithDraft();
    const before = sandbox.withRules((rules) => rules.getRule(ruleId));
    const result = sally(command, String(ruleId));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${action} a rule is done by the user in Sally's web app`);
    expect(result.stderr).toContain("Nothing was changed.");
    sandbox.withRules((rules) => {
      expect(rules.getRule(ruleId)).toEqual(before);
      expect(rules.liveRules("message")).toMatchObject([{ ruleId, versionNumber: 1, instruction: "Give a local link." }]);
    });
  });

  it("says in its help that publishing, switching off and deleting are done in the app", () => {
    const help = sally("help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Publishing, switching off and deleting a rule are done by the user");
  });
});
