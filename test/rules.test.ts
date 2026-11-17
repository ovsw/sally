import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuleError } from "../src/rules.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";

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
