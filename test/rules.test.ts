import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { conditionsFor, RuleError, RuleNotFoundError } from "../src/rules.ts";
import { folder } from "./support/git.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const rule = { name: "A rule", instruction: "Do X.", conditions: conditionsFor("message", ["Condition A."]) };

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

  it("never gives a dropped condition's id to a later condition", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      const dropped = rules.getRule(ruleId).draft!.conditions[0]!.id;
      rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [] });
      rules.saveDraft(ruleId, { instruction: "Do X.", conditions: conditionsFor("reply", ["Condition R."]) });
      expect(rules.getRule(ruleId).draft!.conditions[0]!.id).not.toBe(dropped);
    });
  });

  it("numbers each publish as a new version and leaves no draft behind", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
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
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do X.", conditions: conditionsFor("message", ["Condition A."]) });
      expect(rules.liveRules("message")[0]).toMatchObject({ name: "A rule" });
      expect(rules.listRules()).toMatchObject([{ name: "A rule", hasDraft: true }]);
      rules.publish(ruleId);
      expect(rules.liveRules("message")[0]).toMatchObject({ name: "Renamed" });
      expect(() => rules.createRule({ ...rule, name: "Renamed" })).toThrow(RuleError);
    });
  });

  describe("conditions and their switches", () => {
    const message = (text: string) => ({ text, message: true, reply: false });
    const reply = (text: string) => ({ text, message: false, reply: true });
    const both = (text: string) => ({ text, message: true, reply: true });
    const texts = (live: { conditions: { text: string }[] }[]) => live.map((r) => r.conditions.map((c) => c.text));

    it("takes a rule into each check its conditions are on for, with only those conditions", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({
          ...rule,
          conditions: [message("Asks for X."), reply("Does X badly."), both("Mentions X.")],
        });
        rules.publish(ruleId);
        expect(texts(rules.liveRules("message"))).toEqual([["Asks for X.", "Mentions X."]]);
        expect(texts(rules.liveRules("reply"))).toEqual([["Does X badly.", "Mentions X."]]);
        expect(rules.getRule(ruleId)).toMatchObject({
          checkTypes: ["message", "reply"],
          live: { conditions: [message("Asks for X."), reply("Does X badly."), both("Mentions X.")] },
        });
      });
    });

    it("never scores a condition with both switches off", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [message("On."), { text: "Off.", message: false, reply: false }] });
        rules.publish(ruleId);
        expect(texts(rules.liveRules("message"))).toEqual([["On."]]);
        expect(rules.liveRules("reply")).toEqual([]);
        expect(rules.getRule(ruleId).checkTypes).toEqual(["message"]);
      });
    });

    it("refuses a condition without its switches, and a rule with no condition switched on", () => {
      sandbox.withRules((rules) => {
        expect(() => rules.createRule({ ...rule, conditions: [{ text: "No switches." } as never] })).toThrow(RuleError);
        expect(() => rules.createRule({ ...rule, conditions: ["Plain text." as never] })).toThrow(RuleError);
        expect(() => rules.createRule({ ...rule, conditions: [{ text: "Off.", message: false, reply: false }] })).toThrow(
          "A rule needs at least one condition with its Message or Reply switch on.",
        );
        const { ruleId } = rules.createRule(rule);
        expect(() => rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [{ text: "New, no switches." }] })).toThrow(
          RuleError,
        );
        expect(() => rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [{ id: 999, text: "Not this rule's." }] })).toThrow(
          RuleError,
        );
        rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [{ text: "Off.", message: false, reply: false }] });
        expect(() => rules.publish(ruleId)).toThrow(RuleError);
      });
    });

    it("keeps a condition's switches when its wording changes in a published draft", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [reply("Old wording.")] });
        rules.publish(ruleId);
        const [condition] = rules.getRule(ruleId).live!.conditions;
        // Switches given for a published condition are not the draft's to change.
        rules.saveDraft(ruleId, {
          instruction: "Do X.",
          conditions: [{ id: condition!.id, text: "New wording.", message: true, reply: false }],
        });
        rules.publish(ruleId);
        expect(rules.getRule(ruleId).live!.conditions).toEqual([{ id: condition!.id, ...reply("New wording.") }]);
        expect(rules.liveRules("reply")).toMatchObject([{ conditions: [{ id: condition!.id, text: "New wording." }] }]);
        expect(rules.liveRules("message")).toEqual([]);
        // The old version still words it as it was.
        expect(rules.getRule(ruleId).versions[1]!.conditions).toEqual([{ id: condition!.id, ...reply("Old wording.") }]);
      });
    });

    it("counts a condition added in a draft only once the draft is published", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        const [kept] = rules.getRule(ruleId).live!.conditions;
        rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [kept!, reply("Reply condition.")] });
        expect(rules.liveRules("reply")).toEqual([]);
        expect(rules.getRule(ruleId).checkTypes).toEqual(["message"]);
        rules.publish(ruleId);
        expect(texts(rules.liveRules("reply"))).toEqual([["Reply condition."]]);
        expect(texts(rules.liveRules("message"))).toEqual([["Condition A."]]);
        expect(rules.getRule(ruleId).checkTypes).toEqual(["message", "reply"]);
      });
    });

    it("keeps a condition dropped in a draft working until the draft is published", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [message("Stays."), message("Goes.")] });
        rules.publish(ruleId);
        const [stays] = rules.getRule(ruleId).live!.conditions;
        rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [stays!] });
        expect(texts(rules.liveRules("message"))).toEqual([["Stays.", "Goes."]]);
        rules.publish(ruleId);
        expect(texts(rules.liveRules("message"))).toEqual([["Stays."]]);
      });
    });

    it("lets a new condition's switches change with each save until it is published", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        const [kept] = rules.getRule(ruleId).live!.conditions;
        rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [kept!, message("New.")] });
        const added = rules.getRule(ruleId).draft!.conditions[1]!;
        rules.saveDraft(ruleId, { instruction: "Do X.", conditions: [kept!, { ...added, message: false, reply: true }] });
        expect(rules.getRule(ruleId).draft!.conditions).toEqual([kept, { id: added.id, ...reply("New.") }]);
        // A discarded draft takes its new conditions with it.
        rules.discardDraft(ruleId);
        expect(rules.getRule(ruleId)).toMatchObject({ draft: null, checkTypes: ["message"], live: { conditions: [kept] } });
        expect(rules.liveRules("reply")).toEqual([]);
      });
    });

    it("starts a draft from an old version with its wording, each condition keeping the switches it has now", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [reply("First wording.")] });
        rules.publish(ruleId);
        const [condition] = rules.getRule(ruleId).live!.conditions;
        rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: [{ id: condition!.id, text: "Second wording." }] });
        rules.publish(ruleId);
        rules.startDraftFrom(ruleId, 1);
        expect(rules.getRule(ruleId).draft).toMatchObject({
          instruction: "Do X.",
          conditions: [{ id: condition!.id, ...reply("First wording.") }],
        });
      });
    });

    describe("switching a condition at once", () => {
      it("takes effect on the next check with no new version, leaving the draft as it was", () => {
        sandbox.withRules((rules) => {
          const { ruleId } = rules.createRule({ ...rule, conditions: [message("First."), message("Second.")] });
          rules.publish(ruleId);
          const [first, second] = rules.getRule(ruleId).live!.conditions;
          rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: [{ id: first!.id, text: "First, reworded." }] });
          const draftBefore = rules.getRule(ruleId).draft!;

          rules.setConditionSwitch(ruleId, second!.id, "reply", true);
          rules.setConditionSwitch(ruleId, first!.id, "message", false);

          expect(texts(rules.liveRules("message"))).toEqual([["Second."]]);
          expect(texts(rules.liveRules("reply"))).toEqual([["Second."]]);
          const after = rules.getRule(ruleId);
          expect(after.versions).toHaveLength(1);
          expect(after.live!.conditions).toEqual([
            { id: first!.id, text: "First.", message: false, reply: false },
            { id: second!.id, ...both("Second.") },
          ]);
          expect(after.checkTypes).toEqual(["message", "reply"]);
          expect(after.draft).toMatchObject({
            savedAt: draftBefore.savedAt,
            instruction: "Do Y.",
            conditions: [{ id: first!.id, text: "First, reworded." }],
          });
          expect(after.on).toBe(true);
        });
      });

      it("switches the rule off with its last condition, and keeps it off when a condition comes back on", () => {
        sandbox.withRules((rules) => {
          const { ruleId } = rules.createRule({ ...rule, conditions: [message("First."), both("Second.")] });
          rules.publish(ruleId);
          const [first, second] = rules.getRule(ruleId).live!.conditions;

          rules.setConditionSwitch(ruleId, first!.id, "message", false);
          rules.setConditionSwitch(ruleId, second!.id, "message", false);
          expect(rules.getRule(ruleId).on).toBe(true);
          rules.setConditionSwitch(ruleId, second!.id, "reply", false);
          expect(rules.getRule(ruleId).on).toBe(false);
          expect(rules.liveRules("message")).toEqual([]);
          expect(rules.liveRules("reply")).toEqual([]);

          rules.setConditionSwitch(ruleId, second!.id, "reply", true);
          expect(rules.getRule(ruleId).on).toBe(false);
          expect(rules.liveRules("reply")).toEqual([]);
          rules.switchOn(ruleId);
          expect(texts(rules.liveRules("reply"))).toEqual([["Second."]]);
        });
      });

      it("refuses to switch a rule on while none of its conditions is on", () => {
        sandbox.withRules((rules) => {
          const { ruleId } = rules.createRule(rule);
          rules.publish(ruleId);
          const [condition] = rules.getRule(ruleId).live!.conditions;
          rules.setConditionSwitch(ruleId, condition!.id, "message", false);

          expect(() => rules.switchOn(ruleId)).toThrow(
            "None of this rule's conditions is on. Switch a condition's Message or Reply on first, then the rule.",
          );
          expect(rules.getRule(ruleId)).toMatchObject({ on: false, live: { conditions: [{ message: false, reply: false }] } });
        });
      });

      it("refuses a condition that is not published yet, or not the rule's, or a switch that is not one", () => {
        sandbox.withRules((rules) => {
          const { ruleId } = rules.createRule(rule);
          const [unpublished] = rules.getRule(ruleId).draft!.conditions;
          expect(() => rules.setConditionSwitch(ruleId, unpublished!.id, "reply", true)).toThrow(
            "This condition is not published yet. Set its switches in the draft.",
          );
          rules.publish(ruleId);
          const other = rules.createRule({ ...rule, name: "Other" }).ruleId;
          rules.publish(other);
          const [othersCondition] = rules.getRule(other).live!.conditions;
          expect(() => rules.setConditionSwitch(ruleId, othersCondition!.id, "reply", true)).toThrow(RuleNotFoundError);
          expect(() => rules.setConditionSwitch(999, unpublished!.id, "reply", true)).toThrow(RuleNotFoundError);
          expect(() => rules.setConditionSwitch(ruleId, unpublished!.id, "both" as never, true)).toThrow(RuleError);
          expect(rules.liveRules("reply")).toEqual([]);
        });
      });
    });

    it("lists a rule under every check type one of its conditions is on for", () => {
      sandbox.withRules((rules) => {
        const messageOnly = rules.createRule({ ...rule, name: "Message only" }).ruleId;
        const replyOnly = rules.createRule({ ...rule, name: "Reply only", conditions: [reply("R.")] }).ruleId;
        const inBoth = rules.createRule({ ...rule, name: "In both", conditions: [message("M."), reply("R.")] }).ruleId;
        for (const id of [messageOnly, replyOnly, inBoth]) rules.publish(id);
        const names = (checkType: "message" | "reply") => rules.listRules({ checkType }).map((r) => r.name);
        expect(names("message")).toEqual(["In both", "Message only"]);
        expect(names("reply")).toEqual(["In both", "Reply only"]);
        expect(rules.listRules().map((r) => [r.name, r.checkTypes])).toEqual([
          ["In both", ["message", "reply"]],
          ["Message only", ["message"]],
          ["Reply only", ["reply"]],
        ]);
        // A never-published rule is listed under its draft's check types.
        const draftOnly = rules.createRule({ ...rule, name: "Draft only", conditions: [reply("R.")] }).ruleId;
        expect(rules.listRules({ checkType: "reply" })).toMatchObject([{ id: draftOnly, published: false }, {}, {}]);
        expect(rules.liveRules("reply").map((r) => r.ruleId)).toEqual([replyOnly, inBoth]);
      });
    });
  });

  it("refuses a rule without a name, an instruction or a condition, or with a taken name", () => {
    sandbox.withRules((rules) => {
      expect(() => rules.createRule({ ...rule, name: " " })).toThrow(RuleError);
      expect(() => rules.createRule({ ...rule, instruction: "" })).toThrow(RuleError);
      expect(() => rules.createRule({ ...rule, conditions: conditionsFor("message", ["  "]) })).toThrow(RuleError);
      expect(() => rules.createRule({ ...rule, conditions: conditionsFor("message", ["a".repeat(200_000)]) })).toThrow(RuleError);
      rules.createRule(rule);
      expect(() => rules.createRule(rule)).toThrow(RuleError);
    });
  });

  it("lists every published version with its date, newest first, and never changes one", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      expect(rules.getRule(ruleId).versions).toEqual([]);
      rules.publish(ruleId);
      const first = rules.getRule(ruleId).versions;
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Do Z.", conditions: conditionsFor("message", ["Condition C."]) });

      const { versions, live } = rules.getRule(ruleId);
      expect(versions).toEqual([
        {
          number: 2,
          publishedAt: expect.any(String),
          name: "Renamed",
          instruction: "Do Y.",
          conditions: [{ id: expect.any(Number), text: "Condition B.", message: true, reply: false }],
        },
        first[0],
      ]);
      expect(first).toEqual([
        {
          number: 1,
          publishedAt: expect.any(String),
          name: "A rule",
          instruction: "Do X.",
          conditions: [{ id: expect.any(Number), text: "Condition A.", message: true, reply: false }],
        },
      ]);
      expect(Number.isNaN(Date.parse(versions[0]!.publishedAt))).toBe(false);
      expect(live).toEqual(versions[0]);
    });
  });

  it("starts a draft from an old version, replacing any draft, and leaves the live version alone", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B.", "Condition C."]) });
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Half-finished.", conditions: conditionsFor("message", []) });

      rules.startDraftFrom(ruleId, 1);
      const detail = rules.getRule(ruleId);
      expect(detail.draft).toMatchObject({ name: "A rule", instruction: "Do X.", conditions: [{ text: "Condition A." }] });
      expect(detail.live).toMatchObject({ number: 2, name: "Renamed" });
      expect(rules.liveRules("message")[0]).toMatchObject({ versionNumber: 2, instruction: "Do Y." });

      expect(rules.publish(ruleId)).toEqual({ versionNumber: 3 });
      expect(rules.getRule(ruleId).versions.map((v) => [v.number, v.instruction])).toEqual([
        [3, "Do X."],
        [2, "Do Y."],
        [1, "Do X."],
      ]);
      expect(() => rules.startDraftFrom(ruleId, 9)).toThrow(RuleNotFoundError);
    });
  });

  it("refuses to start a draft from a version whose name another rule now uses", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do X.", conditions: conditionsFor("message", ["Condition A."]) });
      rules.publish(ruleId);
      rules.createRule({ ...rule, name: "A rule" });
      expect(() => rules.startDraftFrom(ruleId, 1)).toThrow(RuleError);
      expect(rules.getRule(ruleId).draft).toBeNull();
    });
  });

  it("discards a draft, keeping the live version and its name", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
      rules.discardDraft(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ name: "A rule", hasDraft: false, draft: null, live: { number: 1 } });
      expect(rules.liveRules("message")[0]).toMatchObject({ name: "A rule", instruction: "Do X." });
      expect(() => rules.publish(ruleId)).toThrow(RuleError);
      expect(() => rules.discardDraft(ruleId)).toThrow(RuleError);
      // The discarded draft's name is free again.
      expect(() => rules.createRule({ ...rule, name: "Renamed" })).not.toThrow();
    });
  });

  it("will not discard the draft of a rule never published, since it is all the rule has", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      expect(() => rules.discardDraft(ruleId)).toThrow(RuleError);
      expect(rules.getRule(ruleId).draft).toMatchObject({ instruction: "Do X." });
    });
  });

  it("switches a rule off and on without losing its versions or draft", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });

      rules.switchOff(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.getRule(ruleId)).toMatchObject({
        published: true,
        on: false,
        hasDraft: true,
        live: { number: 1 },
        draft: { instruction: "Do Y." },
      });
      expect(rules.listRules({ on: false })).toMatchObject([{ id: ruleId, published: true, on: false, hasDraft: true }]);
      expect(rules.listRules({ on: true })).toEqual([]);
      expect(rules.listRules({ published: true, hasDraft: true })).toMatchObject([{ id: ruleId }]);

      // Publishing while off keeps the rule off.
      rules.publish(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.getRule(ruleId).versions).toHaveLength(2);

      rules.switchOn(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ published: true, on: true });
      expect(rules.liveRules("message")).toMatchObject([{ ruleId, versionNumber: 2, instruction: "Do Y." }]);
    });
  });

  it("keeps a rule switched off before its first publish off once published", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.switchOff(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ published: false, on: false });
      rules.publish(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ published: true, on: false });
      expect(rules.liveRules("message")).toEqual([]);
    });
  });

  it("deletes a rule with all its versions and draft, freeing its name", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
      const other = rules.createRule({ ...rule, name: "Other" }).ruleId;
      rules.publish(other);

      rules.deleteRule(ruleId);
      expect(() => rules.getRule(ruleId)).toThrow(RuleNotFoundError);
      expect(rules.listRules().map((r) => r.name)).toEqual(["Other"]);
      expect(rules.liveRules("message").map((r) => r.ruleId)).toEqual([other]);
      expect(sandbox.query("SELECT 1 FROM versions WHERE rule_id = ?", ruleId)).toEqual([]);
      expect(() => rules.createRule({ ...rule, name: "A rule" })).not.toThrow();
      expect(() => rules.createRule({ ...rule, name: "Renamed" })).not.toThrow();
    });
  });

  it("refuses every change to a rule that does not exist", () => {
    sandbox.withRules((rules) => {
      expect(() => rules.startDraftFrom(999, 1)).toThrow(RuleNotFoundError);
      expect(() => rules.discardDraft(999)).toThrow(RuleNotFoundError);
      expect(() => rules.switchOff(999)).toThrow(RuleNotFoundError);
      expect(() => rules.switchOn(999)).toThrow(RuleNotFoundError);
      expect(() => rules.deleteRule(999)).toThrow(RuleNotFoundError);
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
        expect(rules.getRule(ruleId).scope).toEqual({ kind: "all" });
      });
    });

    it("lists the seen projects by name", async () => {
      const [b, a] = await see("b", "a");
      sandbox.withRules((rules) => {
        expect(rules.projects().map((p) => p.name)).toEqual([a, b]);
        expect(Date.parse(rules.projects()[0]!.firstSeenAt)).not.toBeNaN();
      });
    });

    it("takes effect at once, with no new version and the draft untouched", async () => {
      const [a, b] = await see("a", "b");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
        const before = rules.getRule(ruleId);
        expect(rules.liveRules("message", "elsewhere")).toHaveLength(1);

        rules.setScope(ruleId, { kind: "projects", projects: [b, a, b] });
        const after = rules.getRule(ruleId);
        expect(after.scope).toEqual({ kind: "projects", projects: [a, b] });
        expect(after.versions).toEqual(before.versions);
        expect(after.draft).toEqual(before.draft);
        expect(rules.liveRules("message", "elsewhere")).toEqual([]);
        expect(rules.liveRules("message")).toEqual([]);
        expect(rules.liveRules("message", a)).toHaveLength(1);
        expect(rules.listRules({ allProjects: false }).map((r) => r.id)).toEqual([ruleId]);

        rules.setScope(ruleId, { kind: "all" });
        expect(rules.liveRules("message", "elsewhere")).toHaveLength(1);
        expect(rules.getRule(ruleId).versions).toEqual(before.versions);
      });
    });

    it("keeps the scope through saving and publishing a draft", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, scope: { kind: "projects", projects: [a] } });
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
        rules.publish(ruleId);
        expect(rules.getRule(ruleId).scope).toEqual({ kind: "projects", projects: [a] });
        expect(rules.liveRules("message", a)).toHaveLength(1);
        expect(rules.liveRules("message", "elsewhere")).toEqual([]);
      });
    });

    it("starts a draft from an old version with its wording only, keeping the scope as it is", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, scope: { kind: "projects", projects: [a] } });
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: conditionsFor("message", ["Condition B."]) });
        rules.publish(ruleId);
        rules.setScope(ruleId, { kind: "all" });
        rules.startDraftFrom(ruleId, 1);
        expect(rules.getRule(ruleId)).toMatchObject({
          scope: { kind: "all" },
          draft: { instruction: rule.instruction },
        });
        rules.publish(ruleId);
        expect(rules.getRule(ruleId).scope).toEqual({ kind: "all" });
      });
    });

    it("sets the scope of a rule never published, which it keeps when published", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.setScope(ruleId, { kind: "projects", projects: [a] });
        expect(rules.getRule(ruleId)).toMatchObject({ published: false, hasDraft: true, scope: { kind: "projects", projects: [a] } });
        rules.publish(ruleId);
        expect(rules.liveRules("message", a)).toHaveLength(1);
        expect(rules.liveRules("message", "elsewhere")).toEqual([]);
      });
    });

    it("refuses a project Sally has not seen, and a scope with no project", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        expect(() => rules.createRule({ ...rule, scope: { kind: "projects", projects: ["never/seen"] } })).toThrow(
          RuleError,
        );
        expect(() => rules.createRule({ ...rule, scope: { kind: "projects", projects: [] } })).toThrow(RuleError);
        const { ruleId } = rules.createRule({ ...rule, scope: { kind: "projects", projects: [a] } });
        expect(() => rules.setScope(ruleId, { kind: "projects", projects: ["never/seen"] })).toThrow(RuleError);
        expect(() => rules.setScope(ruleId, { kind: "projects", projects: [] })).toThrow(RuleError);
        expect(() => rules.setScope(999, { kind: "all" })).toThrow(RuleNotFoundError);
        expect(rules.getRule(ruleId).scope).toEqual({ kind: "projects", projects: [a] });
      });
    });
  });

  describe("switch changes", () => {
    const message = (text: string) => ({ text, message: true, reply: false });
    /** The changes without their ids and times, oldest first. */
    const changes = (detail: { switchChanges: { id: number; at: string }[] }) =>
      detail.switchChanges
        .map((change) => Object.fromEntries(Object.entries(change).filter(([key]) => key !== "id" && key !== "at")))
        .reverse();

    it("records each change to the rule's switch, a condition's switches and the scope, newest first, with its time", async () => {
      const [a, b] = [folder(sandbox.root, "a"), folder(sandbox.root, "b")];
      for (const cwd of [a, b]) {
        await runMessageHook(hookInput("hello there", { cwd }), { env: sandbox.env, matcher: standInMatcher() });
      }
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [message("First."), message("Second.")] });
        rules.publish(ruleId);
        expect(rules.getRule(ruleId).switchChanges).toEqual([]);
        const [first, second] = rules.getRule(ruleId).live!.conditions;

        rules.switchOff(ruleId);
        rules.switchOn(ruleId);
        rules.setConditionSwitch(ruleId, first!.id, "reply", true);
        rules.setConditionSwitch(ruleId, second!.id, "message", false);
        rules.setScope(ruleId, { kind: "projects", projects: [b, a, b] });
        rules.setScope(ruleId, { kind: "all" });

        const detail = rules.getRule(ruleId);
        expect(changes(detail)).toEqual([
          { what: "rule", on: false, bySally: false },
          { what: "rule", on: true, bySally: false },
          { what: "condition", conditionId: first!.id, conditionText: "First.", checkType: "reply", on: true },
          { what: "condition", conditionId: second!.id, conditionText: "Second.", checkType: "message", on: false },
          { what: "scope", scope: { kind: "projects", projects: [a, b] } },
          { what: "scope", scope: { kind: "all" } },
        ]);
        const times = detail.switchChanges.map((change) => Date.parse(change.at));
        expect(times.every((time) => !Number.isNaN(time))).toBe(true);
        expect(times).toEqual([...times].sort((x, y) => y - x));
        // None of it is a version.
        expect(detail.versions).toHaveLength(1);
      });
    });

    it("records the rule going off with its last condition after the condition switch that caused it", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        const [condition] = rules.getRule(ruleId).live!.conditions;

        rules.setConditionSwitch(ruleId, condition!.id, "message", false);
        expect(rules.getRule(ruleId).switchChanges).toMatchObject([
          { what: "rule", on: false, bySally: true },
          { what: "condition", conditionId: condition!.id, checkType: "message", on: false },
        ]);
        // Switching the condition back on does not switch the rule on, so only the condition is recorded.
        rules.setConditionSwitch(ruleId, condition!.id, "message", true);
        expect(rules.getRule(ruleId).switchChanges).toHaveLength(3);
        expect(rules.getRule(ruleId).switchChanges[0]).toMatchObject({ what: "condition", on: true });
      });
    });

    it("records nothing for a switch or scope set to what it already was, or for a refused change", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.publish(ruleId);
        const [condition] = rules.getRule(ruleId).live!.conditions;

        rules.switchOn(ruleId);
        rules.setConditionSwitch(ruleId, condition!.id, "message", true);
        rules.setConditionSwitch(ruleId, condition!.id, "reply", false);
        rules.setScope(ruleId, { kind: "all" });
        expect(rules.getRule(ruleId).switchChanges).toEqual([]);

        rules.setConditionSwitch(ruleId, condition!.id, "message", false);
        expect(() => rules.switchOn(ruleId)).toThrow(RuleError);
        rules.switchOff(ruleId);
        expect(rules.getRule(ruleId).switchChanges).toHaveLength(2);
      });
    });

    it("names a condition by its published wording at the time it was switched", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, conditions: [message("First."), message("Second.")] });
        rules.publish(ruleId);
        const [first] = rules.getRule(ruleId).live!.conditions;
        rules.saveDraft(ruleId, {
          instruction: "Do X.",
          conditions: [{ id: first!.id, text: "First, reworded." }, message("Second.")],
        });
        rules.setConditionSwitch(ruleId, first!.id, "reply", true);
        rules.publish(ruleId);
        rules.setConditionSwitch(ruleId, first!.id, "reply", false);

        expect(changes(rules.getRule(ruleId)).map((change) => "conditionText" in change && change.conditionText)).toEqual([
          "First.",
          "First, reworded.",
        ]);
      });
    });

    it("goes with the rule when it is deleted", () => {
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule(rule);
        rules.switchOff(ruleId);
        rules.deleteRule(ruleId);
        const again = rules.createRule(rule).ruleId;
        expect(rules.getRule(again).switchChanges).toEqual([]);
      });
    });
  });

  const defaults = {
    cutoff: 0.6,
    replyCutoff: 0.6,
    timeLimitMs: 10_000,
    stopOnFailure: true,
    recentChecks: 100,
    busyShare: 0.3,
    closeMargin: 0.05,
    quietChecks: 200,
  };

  it("gives the default settings until they are changed, then the stored ones", () => {
    sandbox.withRules((rules) => {
      expect(rules.settings()).toEqual(defaults);
      expect(rules.updateSettings({ timeLimitMs: 5000, busyShare: 0.5, quietChecks: 50 })).toEqual({
        ...defaults,
        timeLimitMs: 5000,
        busyShare: 0.5,
        quietChecks: 50,
      });
    });
    sandbox.withRules((rules) => {
      expect(rules.settings()).toEqual({ ...defaults, timeLimitMs: 5000, busyShare: 0.5, quietChecks: 50 });
    });
  });

  it("stops the turn on a failed check until that is switched off, and again when switched back on", () => {
    sandbox.withRules((rules) => {
      expect(rules.settings().stopOnFailure).toBe(true);
      expect(rules.updateSettings({ stopOnFailure: false })).toEqual({ ...defaults, stopOnFailure: false });
    });
    sandbox.withRules((rules) => {
      expect(rules.settings().stopOnFailure).toBe(false);
      expect(rules.updateSettings({ stopOnFailure: true }).stopOnFailure).toBe(true);
    });
  });

  it.each([
    [{ cutoff: 1.2 }],
    [{ cutoff: -0.1 }],
    [{ replyCutoff: 1.5 }],
    [{ timeLimitMs: 0 }],
    [{ timeLimitMs: 10_001 }],
    [{ timeLimitMs: Number.NaN }],
    [{ recentChecks: 0 }],
    [{ recentChecks: 10.5 }],
    [{ busyShare: 0 }],
    [{ busyShare: 1.5 }],
    [{ closeMargin: -0.01 }],
    [{ closeMargin: 2 }],
    [{ quietChecks: 0 }],
    [{ quietChecks: Number.POSITIVE_INFINITY }],
    [{ stopOnFailure: 1 as unknown as boolean }],
    [{ cutoff: true as unknown as number }],
  ])("refuses the setting %o and stores nothing", (change) => {
    sandbox.withRules((rules) => {
      expect(() => rules.updateSettings({ timeLimitMs: 4000, ...change })).toThrow(RuleError);
      expect(rules.settings()).toEqual(defaults);
    });
  });
});
