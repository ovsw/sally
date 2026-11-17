import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { RuleError } from "../src/rules.ts";
import { folder } from "./support/git.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const rule = { name: "A rule", checkType: "message" as const, instruction: "Do X.", conditions: ["Condition A."] };

describe("rules service", () => {
  it("creates a rule as a draft that is not live until published", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.publish(ruleId)).toEqual({ versionNumber: 1 });
      expect(rules.liveRules("message")).toMatchObject([
        { ruleId, name: "A rule", versionNumber: 1, instruction: "Do X.", conditions: [{ text: "Condition A." }] },
      ]);
    });
  });

  it("numbers each publish as a new version and leaves no draft behind", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: ["Condition B."] });
      expect(rules.liveRules("message")).toMatchObject([
        { versionNumber: 1, instruction: "Do X.", conditions: [{ text: "Condition A." }] },
      ]);
      expect(rules.publish(ruleId)).toEqual({ versionNumber: 2 });
      expect(rules.liveRules("message")[0]).toMatchObject({ versionNumber: 2, instruction: "Do Y." });
      expect(() => rules.publish(ruleId)).toThrow(RuleError);
    });
  });

  it("keeps the instruction exactly as written", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule({ ...rule, instruction: "  Do X.\n" });
      rules.publish(ruleId);
      expect(rules.liveRules("message")[0]).toMatchObject({ instruction: "  Do X.\n" });
    });
  });

  it("keeps a draft's new name out of the live version until it is published", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do X.", conditions: ["Condition A."] });
      expect(rules.liveRules("message")[0]).toMatchObject({ name: "A rule" });
      expect(rules.listRules()).toMatchObject([{ name: "A rule", hasDraft: true }]);
      rules.publish(ruleId);
      expect(rules.liveRules("message")[0]).toMatchObject({ name: "Renamed" });
      expect(() => rules.createRule({ ...rule, name: "Renamed" })).toThrow(RuleError);
    });
  });

  it("refuses a rule without a name, an instruction or a condition, or with a taken name", () => {
    sandbox.withRules((rules) => {
      expect(() => rules.createRule({ ...rule, name: " " })).toThrow(RuleError);
      expect(() => rules.createRule({ ...rule, instruction: "" })).toThrow(RuleError);
      expect(() => rules.createRule({ ...rule, conditions: ["  "] })).toThrow(RuleError);
      rules.createRule(rule);
      expect(() => rules.createRule(rule)).toThrow(RuleError);
    });
  });

  describe("scope", () => {
    /** Records projects the way they are seen: by a check run in each folder. */
    async function see<const T extends string[]>(...names: T): Promise<{ [K in keyof T]: string }> {
      const folders = names.map((name) => folder(sandbox.root, name));
      for (const cwd of folders) {
        await runMessageHook(hookInput("hello there", { cwd }), { env: sandbox.env, matcher: standInMatcher() });
      }
      return folders as { [K in keyof T]: string };
    }

    it("applies a new rule to all projects unless given a scope", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        expect(rules.getRule(ruleId).draft).toMatchObject({ scope: { kind: "all" } });
      });
    });

    it("lists the seen projects by name", async () => {
      const [b, a] = await see("b", "a");
      sandbox.withRules((rules) => {
        expect(rules.projects().map((p) => p.name)).toEqual([a, b]);
        expect(Date.parse(rules.projects()[0]!.firstSeenAt)).not.toBeNaN();
      });
    });

    it("keeps a draft's scope out of the live version until it is published", async () => {
      const [a, b] = await see("a", "b");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { ...rule, scope: { kind: "projects", projects: [b, a, b] } });
        expect(rules.getRule(ruleId)).toMatchObject({
          live: { scope: { kind: "all" } },
          draft: { scope: { kind: "projects", projects: [a, b] } },
        });
        expect(rules.liveRules("message", "elsewhere")).toHaveLength(1);
        rules.publish(ruleId);
        expect(rules.getRule(ruleId).live).toMatchObject({ scope: { kind: "projects", projects: [a, b] } });
        expect(rules.liveRules("message", "elsewhere")).toEqual([]);
        expect(rules.liveRules("message")).toEqual([]);
        expect(rules.liveRules("message", a)).toHaveLength(1);
      });
    });

    it("keeps the scope it has when a draft is saved without one", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, scope: { kind: "projects", projects: [a] } });
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: ["Condition B."] });
        expect(rules.getRule(ruleId).draft).toMatchObject({ scope: { kind: "projects", projects: [a] } });
      });
    });

    it("refuses a project Sally has not seen, and publishing a scope with no project", async () => {
      await see("a");
      sandbox.withRules((rules) => {
        expect(() => rules.createRule({ ...rule, scope: { kind: "projects", projects: ["never/seen"] } })).toThrow(
          RuleError,
        );
        expect(() => rules.createRule({ ...rule, scope: { kind: "projects", projects: [] } })).toThrow(RuleError);
        const { ruleId } = rules.createRule(rule);
        expect(() =>
          rules.saveDraft(ruleId, { ...rule, scope: { kind: "projects", projects: ["never/seen"] } }),
        ).toThrow(RuleError);
        rules.saveDraft(ruleId, { ...rule, scope: { kind: "projects", projects: [] } });
        expect(() => rules.publish(ruleId)).toThrow(RuleError);
        expect(rules.liveRules("message")).toEqual([]);
      });
    });
  });

  it("gives the default settings until they are changed, then the stored ones", () => {
    sandbox.withRules((rules) => {
      expect(rules.settings()).toEqual({ cutoff: 0.6, cap: 3, timeLimitMs: 3000 });
      expect(rules.updateSettings({ cap: 5 })).toEqual({ cutoff: 0.6, cap: 5, timeLimitMs: 3000 });
    });
    sandbox.withRules((rules) => {
      expect(rules.settings()).toEqual({ cutoff: 0.6, cap: 5, timeLimitMs: 3000 });
    });
  });

  it.each([
    [{ cutoff: 1.2 }],
    [{ cutoff: -0.1 }],
    [{ cap: 0 }],
    [{ cap: 2.5 }],
    [{ timeLimitMs: 0 }],
    [{ timeLimitMs: Number.NaN }],
  ])("refuses the setting %o and stores nothing", (change) => {
    sandbox.withRules((rules) => {
      expect(() => rules.updateSettings({ cap: 4, ...change })).toThrow(RuleError);
      expect(rules.settings()).toEqual({ cutoff: 0.6, cap: 3, timeLimitMs: 3000 });
    });
  });
});
