import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleDetail, RuleSummary } from "../src/rules.ts";
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
    rules.saveDraft(ruleId, { instruction: "Give the localhost link.", conditions: ["The reply reports a visual change."] }),
  );
  return ruleId;
}

describe("reading rules", () => {
  it("lists every rule as JSON with its check type, state and draft", () => {
    const linksId = ruleWithDraft();
    const draftId = sandbox.withRules(
      (rules) =>
        rules.createRule({ name: "Brief", checkType: "reply", instruction: "Be brief.", conditions: ["The reply is long."] })
          .ruleId,
    );
    expect(sallyJson("list")).toEqual([
      { id: draftId, name: "Brief", checkType: "reply", state: "draft", on: true, hasDraft: true },
      { id: linksId, name: "Links", checkType: "message", state: "live", on: true, hasDraft: true },
    ]);
  });

  it("narrows the list by search, check type, state and draft", () => {
    ruleWithDraft();
    sandbox.liveRule({ name: "Brief", checkType: "reply", instruction: "Be brief.", conditions: ["The reply is long."] });
    const names = (...args: string[]) => sallyJson("list", ...args).map((rule: { name: string }) => rule.name);
    expect(names("--search", "localhost")).toEqual(["Links"]);
    expect(names("--check-type", "reply")).toEqual(["Brief"]);
    expect(names("--state", "draft")).toEqual([]);
    expect(names("--with-draft")).toEqual(["Links"]);
    expect(names("--without-draft")).toEqual(["Brief"]);
  });

  it("shows one rule, by id or by name, with its live version beside its draft", () => {
    const ruleId = ruleWithDraft();
    const expected = {
      id: ruleId,
      name: "Links",
      checkType: "message",
      state: "live",
      hasDraft: true,
      live: {
        number: 1,
        name: "Links",
        checkType: "message",
        instruction: "Give a local link.",
        conditions: ["The reply is visual."],
      },
      draft: {
        name: "Links",
        checkType: "message",
        instruction: "Give the localhost link.",
        conditions: ["The reply reports a visual change."],
      },
    };
    expect(sallyJson("show", String(ruleId))).toMatchObject(expected);
    expect(sallyJson("show", "Links")).toMatchObject(expected);
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
    expect(created).toMatchObject({ name: "Links", checkType: "reply", state: "draft", hasDraft: true, live: null });
    sandbox.withRules((rules) => {
      expect(rules.liveRules("reply")).toEqual([]);
      expect(rules.listRules()).toMatchObject([{ id: created.id, name: "Links", state: "draft", hasDraft: true }]);
      expect(rules.getRule(created.id).draft).toMatchObject({
        checkType: "reply",
        instruction: "Give the localhost link.",
        conditions: ["The reply reports a visual change.", "The reply hands back a page without a link."],
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

  it("edits a live rule's name, instruction, conditions and check type into a draft, leaving the live version alone", () => {
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
      checkType: "message",
      live: { name: "Links", checkType: "message", instruction: "Give a local link.", conditions: ["The reply is visual."] },
      draft: {
        name: "Local links",
        checkType: "reply",
        instruction: "Give the localhost link.",
        conditions: ["The reply reports a visual change."],
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
      checkType: "message",
      instruction: "Always give the localhost link.",
      conditions: ["The reply reports a visual change."],
    });
    const renamed = sallyJson("edit", "Links", "--name", "Local links");
    expect(renamed.draft).toMatchObject({ name: "Local links", instruction: "Always give the localhost link." });
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
  it("shows a rule created and edited here in the app, with the draft's check type", async () => {
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
      expect(rules).toEqual([{ id: created.id, name: "Links", checkType: "reply", state: "draft", on: true, hasDraft: true }]);
      const rule = await app.json<RuleDetail>("GET", `/api/rules/${created.id}`);
      expect(rule).toMatchObject({
        live: null,
        draft: {
          name: "Links",
          checkType: "reply",
          instruction: "Give the localhost link.",
          conditions: ["The reply reports a visual change."],
        },
      });
      // The user publishes it in the app.
      const published = await app.json<{ versionNumber: number; rule: RuleDetail }>(
        "POST",
        `/api/rules/${created.id}/publish`,
        {},
      );
      expect(published).toMatchObject({ versionNumber: 1, rule: { state: "live", live: { checkType: "reply" } } });
    } finally {
      await app.close();
    }
  });

  it("shows an agent's edit of a live rule as the draft beside the live version in the app", async () => {
    const ruleId = sandbox.liveRule({ name: "Links", instruction: "Give a local link.", conditions: ["The reply is visual."] });
    sallyJson("edit", "Links", "--name", "Local links", "--check-type", "reply");
    const app = await startApp(sandbox);
    try {
      expect(await app.json<RuleDetail>("GET", `/api/rules/${ruleId}`)).toMatchObject({
        name: "Links",
        checkType: "message",
        state: "live",
        hasDraft: true,
        live: { number: 1, name: "Links", checkType: "message", instruction: "Give a local link." },
        draft: { name: "Local links", checkType: "reply", instruction: "Give a local link." },
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
