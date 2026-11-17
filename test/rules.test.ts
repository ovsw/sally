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
      expect(rules.publish(ruleId)).toEqual({ versionNumber: 2 });
      expect(rules.liveRules("message")[0]).toMatchObject({ versionNumber: 2, instruction: "Do Y." });
      expect(() => rules.publish(ruleId)).toThrow(RuleError);
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
});
