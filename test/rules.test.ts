import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { RuleError, RuleNotFoundError } from "../src/rules.ts";
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

  it("keeps a draft's new check type out of the live version until it is published", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { checkType: "reply", instruction: "Do X.", conditions: ["Condition A."] });
      expect(rules.liveRules("message")).toMatchObject([{ ruleId }]);
      expect(rules.liveRules("reply")).toEqual([]);
      expect(rules.getRule(ruleId)).toMatchObject({
        checkType: "message",
        live: { checkType: "message" },
        draft: { checkType: "reply" },
      });
      // A later edit that does not mention the check type keeps the draft's.
      rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: ["Condition A."] });
      expect(rules.getRule(ruleId).draft).toMatchObject({ checkType: "reply", instruction: "Do Y." });
      rules.publish(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.liveRules("reply")).toMatchObject([{ ruleId, versionNumber: 2 }]);
      expect(rules.listRules({ checkType: "reply" })).toMatchObject([{ id: ruleId }]);
    });
  });

  it("files a never-published rule under its draft's check type", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.saveDraft(ruleId, { checkType: "reply", instruction: "Do X.", conditions: ["Condition A."] });
      expect(rules.listRules({ checkType: "reply" })).toMatchObject([{ id: ruleId, state: "draft" }]);
      expect(rules.liveRules("reply")).toEqual([]);
    });
  });

  it("refuses a draft with a check type other than message or reply", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      expect(() =>
        rules.saveDraft(ruleId, { checkType: "tool" as never, instruction: "Do X.", conditions: ["Condition A."] }),
      ).toThrow(RuleError);
      expect(rules.getRule(ruleId).draft).toMatchObject({ checkType: "message" });
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

  it("lists every published version with its date, newest first, and never changes one", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      expect(rules.getRule(ruleId).versions).toEqual([]);
      rules.publish(ruleId);
      const first = rules.getRule(ruleId).versions;
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: ["Condition B."] });
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Do Z.", conditions: ["Condition C."] });

      const { versions, live } = rules.getRule(ruleId);
      expect(versions).toEqual([
        { number: 2, publishedAt: expect.any(String), name: "Renamed", checkType: "message", instruction: "Do Y.", conditions: ["Condition B."], scope: { kind: "all" } },
        first[0],
      ]);
      expect(first).toEqual([
        {
          number: 1,
          publishedAt: expect.any(String),
          name: "A rule",
          checkType: "message",
          instruction: "Do X.",
          conditions: ["Condition A."],
          scope: { kind: "all" },
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
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: ["Condition B.", "Condition C."] });
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { instruction: "Half-finished.", conditions: [] });

      rules.startDraftFrom(ruleId, 1);
      const detail = rules.getRule(ruleId);
      expect(detail.draft).toMatchObject({ name: "A rule", instruction: "Do X.", conditions: ["Condition A."] });
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
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do X.", conditions: ["Condition A."] });
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
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: ["Condition B."] });
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
      rules.saveDraft(ruleId, { instruction: "Do Y.", conditions: ["Condition B."] });

      rules.switchOff(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.getRule(ruleId)).toMatchObject({
        state: "off",
        on: false,
        live: { number: 1 },
        draft: { instruction: "Do Y." },
      });
      expect(rules.listRules({ state: "off" })).toMatchObject([{ id: ruleId, state: "off", on: false }]);
      expect(rules.listRules({ state: "live" })).toEqual([]);

      // Publishing while off keeps the rule off.
      rules.publish(ruleId);
      expect(rules.liveRules("message")).toEqual([]);
      expect(rules.getRule(ruleId).versions).toHaveLength(2);

      rules.switchOn(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ state: "live", on: true });
      expect(rules.liveRules("message")).toMatchObject([{ ruleId, versionNumber: 2, instruction: "Do Y." }]);
    });
  });

  it("keeps a rule switched off before its first publish off once published", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.switchOff(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ state: "draft", on: false });
      rules.publish(ruleId);
      expect(rules.getRule(ruleId)).toMatchObject({ state: "off", on: false });
      expect(rules.liveRules("message")).toEqual([]);
    });
  });

  it("deletes a rule with all its versions and draft, freeing its name", () => {
    sandbox.withRules((rules) => {
      const { ruleId } = rules.createRule(rule);
      rules.publish(ruleId);
      rules.saveDraft(ruleId, { name: "Renamed", instruction: "Do Y.", conditions: ["Condition B."] });
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

    it("starts a draft from an old version with that version's scope", async () => {
      const [a] = await see("a");
      sandbox.withRules((rules) => {
        const { ruleId } = rules.createRule({ ...rule, scope: { kind: "projects", projects: [a] } });
        rules.publish(ruleId);
        rules.saveDraft(ruleId, { ...rule, scope: { kind: "all" } });
        rules.publish(ruleId);
        rules.startDraftFrom(ruleId, 1);
        expect(rules.getRule(ruleId)).toMatchObject({
          live: { number: 2, scope: { kind: "all" } },
          draft: { scope: { kind: "projects", projects: [a] } },
          versions: [{ scope: { kind: "all" } }, { scope: { kind: "projects", projects: [a] } }],
        });
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
