import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import type { RuleDetail, RuleSummary } from "../src/rules.ts";
import { type RunningApp, startApp } from "./support/app.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
let app: RunningApp;
beforeEach(async () => {
  sandbox = createSandbox();
  app = await startApp(sandbox);
});
afterEach(async () => {
  await app.close();
  sandbox.cleanup();
});

const newRule = {
  name: "Local link first",
  checkType: "message",
  instruction: "Show the change on the local dev server first.",
  conditions: ["The message asks for a visual change."],
};

const create = (rule: Partial<typeof newRule> = {}) => app.json<RuleDetail>("POST", "/api/rules", { ...newRule, ...rule });
const list = async (query = "") => (await app.json<{ rules: RuleSummary[] }>("GET", `/api/rules${query}`)).rules;
const names = async (query = "") => (await list(query)).map((r) => r.name);

/** A raw request, to set headers fetch will not let a caller set. */
function rawRequest(path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  const { hostname, port } = new URL(app.address);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

describe("starting the app", () => {
  it("prints its local address and serves the app there", async () => {
    const webDir = join(sandbox.root, "web");
    mkdirSync(webDir);
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Sally</title>");
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "app", "--port", "0"], {
      env: { PATH: process.env.PATH, ...sandbox.env, SALLY_WEB_DIR: webDir },
    });
    try {
      const address = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = out.match(/(http:\/\/\S+)/);
          if (match) resolve(match[1]!);
        });
        child.on("exit", (code) => reject(new Error(`exited with ${code}`)));
      });
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(address + "/rules/1")).text()).toContain("<title>Sally</title>");
      expect(await (await fetch(address + "/api/rules")).json()).toEqual({ rules: [] });
    } finally {
      child.kill();
    }
  });

  it("refuses requests addressed to any host other than this machine", async () => {
    const port = new URL(app.address).port;
    expect(await rawRequest("/api/rules", { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawRequest("/api/rules", { host: `localhost:${port}` })).toBe(200);
    expect(await rawRequest("/api/rules", { host: `attacker.example:${port}` })).toBe(403);
  });

  it("refuses changes sent from another site's page or not sent as JSON", async () => {
    const port = new URL(app.address).port;
    const json = { host: `127.0.0.1:${port}`, "content-type": "application/json" };
    expect(await rawRequest("/api/rules", { ...json, origin: "https://attacker.example" }, "POST")).toBe(403);
    expect(await rawRequest("/api/rules", { host: json.host, "content-type": "text/plain" }, "POST")).toBe(415);
    expect(await app.call("POST", "/api/rules", undefined, { "content-type": "text/plain" })).toHaveProperty(
      "status",
      415,
    );
  });
});

describe("the rules list", () => {
  it("lists every rule with its name, check type, state and whether it has a draft", async () => {
    const live = await create({ name: "Live rule" });
    await app.json("POST", `/api/rules/${live.id}/publish`, {});
    const edited = await create({ name: "Edited rule", checkType: "reply" });
    await app.json("POST", `/api/rules/${edited.id}/publish`, {});
    await app.json("PUT", `/api/rules/${edited.id}/draft`, { instruction: "New wording.", conditions: ["C."] });
    await create({ name: "New rule" });

    expect(await list()).toEqual([
      { id: edited.id, name: "Edited rule", checkType: "reply", state: "live", on: true, hasDraft: true },
      { id: live.id, name: "Live rule", checkType: "message", state: "live", on: true, hasDraft: false },
      { id: expect.any(Number), name: "New rule", checkType: "message", state: "draft", on: true, hasDraft: true },
    ]);
  });

  it("narrows the list by search and by check type, state and draft", async () => {
    const a = await create({ name: "Alpha", instruction: "Link the pull request.", conditions: ["Talks about colour."] });
    await app.json("POST", `/api/rules/${a.id}/publish`, {});
    await create({ name: "Beta", checkType: "reply", instruction: "Say what changed.", conditions: ["Reports a fix."] });
    const c = await create({ name: "Gamma", conditions: ["Mentions a deadline."] });
    await app.json("POST", `/api/rules/${c.id}/publish`, {});
    await app.json("PUT", `/api/rules/${c.id}/draft`, { instruction: "Ask about the PULL request.", conditions: ["X."] });

    expect(await names("?search=beta")).toEqual(["Beta"]);
    expect(await names("?search=pull%20request")).toEqual(["Alpha", "Gamma"]);
    expect(await names("?search=colour")).toEqual(["Alpha"]);
    expect(await names("?checkType=reply")).toEqual(["Beta"]);
    expect(await names("?state=live")).toEqual(["Alpha", "Gamma"]);
    expect(await names("?state=draft")).toEqual(["Beta"]);
    expect(await names("?hasDraft=true")).toEqual(["Beta", "Gamma"]);
    expect(await names("?hasDraft=false&checkType=message")).toEqual(["Alpha"]);
    expect(await names("?search=nothing%20like%20this")).toEqual([]);
    expect((await app.call("GET", "/api/rules?state=sideways")).status).toBe(400);
  });
});

describe("creating, editing and publishing a rule", () => {
  it("creates a rule as a draft only, which the engine does not use", async () => {
    const rule = await create();
    expect(rule).toMatchObject({ state: "draft", live: null, draft: { name: "Local link first" } });

    const matcher = standInMatcher({ "The message asks for a visual change.": 0.9 });
    expect(await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher })).toBe("");
  });

  it("saves edits to name, instruction and conditions into the draft, and they survive a reload", async () => {
    const rule = await create({ conditions: ["First.", "Second.", "Third."] });

    // Change one condition, remove one, add one, rename and reword.
    await app.json("PUT", `/api/rules/${rule.id}/draft`, {
      name: "Local link before PR",
      instruction: "Show it on localhost first.",
      conditions: ["First, changed.", "Third.", "Fourth."],
    });

    await app.close();
    app = await startApp(sandbox);
    const reloaded = await app.json<RuleDetail>("GET", `/api/rules/${rule.id}`);
    expect(reloaded.draft).toMatchObject({
      name: "Local link before PR",
      instruction: "Show it on localhost first.",
      conditions: ["First, changed.", "Third.", "Fourth."],
    });
    expect(await names()).toEqual(["Local link before PR"]);
  });

  it("keeps an unfinished draft but will not publish it", async () => {
    const rule = await create();
    await app.json("PUT", `/api/rules/${rule.id}/draft`, { instruction: "", conditions: [] });
    expect((await app.json<RuleDetail>("GET", `/api/rules/${rule.id}`)).draft).toMatchObject({
      instruction: "",
      conditions: [],
    });
    const response = await app.call("POST", `/api/rules/${rule.id}/publish`, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A rule needs an instruction." });
  });

  it("shows the live version beside the draft", async () => {
    const rule = await create();
    await app.json("POST", `/api/rules/${rule.id}/publish`, {});
    await app.json("PUT", `/api/rules/${rule.id}/draft`, {
      name: "Renamed",
      instruction: "New wording.",
      conditions: ["A new condition."],
    });

    const detail = await app.json<RuleDetail>("GET", `/api/rules/${rule.id}`);
    expect(detail).toMatchObject({
      name: "Local link first",
      state: "live",
      hasDraft: true,
      live: {
        number: 1,
        name: "Local link first",
        instruction: newRule.instruction,
        conditions: newRule.conditions,
      },
      draft: { name: "Renamed", instruction: "New wording.", conditions: ["A new condition."] },
    });
  });

  it("publishes the draft as the new live version, which the engine uses on the next check", async () => {
    const rule = await create();
    const first = await app.json<{ versionNumber: number; rule: RuleDetail }>(
      "POST",
      `/api/rules/${rule.id}/publish`,
      {},
    );
    expect(first.versionNumber).toBe(1);
    expect(first.rule).toMatchObject({ state: "live", hasDraft: false, draft: null });

    await app.json("PUT", `/api/rules/${rule.id}/draft`, {
      name: "Localhost first",
      instruction: "Reworded instruction.",
      conditions: ["The message asks for a layout change."],
    });
    const matcher = standInMatcher({
      "The message asks for a visual change.": 0.9,
      "The message asks for a layout change.": 0.9,
    });
    const before = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    expect(JSON.parse(before).hookSpecificOutput.additionalContext).toContain(newRule.instruction);

    const second = await app.json<{ versionNumber: number }>("POST", `/api/rules/${rule.id}/publish`, {});
    expect(second.versionNumber).toBe(2);

    const after = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const context: string = JSON.parse(after).hookSpecificOutput.additionalContext;
    expect(context).toContain("Rule: Localhost first");
    expect(context).toContain("Reworded instruction.");
    expect(context).not.toContain(newRule.instruction);
  });

  it("refuses a taken name, an unknown rule and a publish with no draft", async () => {
    const first = await create({ name: "First" });
    const second = await create({ name: "Second" });

    const taken = await app.call("POST", "/api/rules", { ...newRule, name: "First" });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toEqual({ error: 'A rule named "First" already exists.' });

    const rename = await app.call("PUT", `/api/rules/${second.id}/draft`, {
      name: "First",
      instruction: "X.",
      conditions: ["Y."],
    });
    expect(rename.status).toBe(400);

    expect((await app.call("GET", "/api/rules/999")).status).toBe(404);
    expect((await app.call("PUT", "/api/rules/999/draft", { instruction: "", conditions: [] })).status).toBe(404);

    await app.json("POST", `/api/rules/${first.id}/publish`, {});
    expect((await app.call("POST", `/api/rules/${first.id}/publish`, {})).status).toBe(400);
  });
});

describe("history and the rest of a rule's life", () => {
  const publish = (id: number) => app.json("POST", `/api/rules/${id}/publish`, {});
  const reword = (id: number, instruction: string, conditions = newRule.conditions) =>
    app.json<RuleDetail>("PUT", `/api/rules/${id}/draft`, { instruction, conditions });
  const sentToJev = async () => {
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.9 });
    const output = await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    return { output, conditions: matcher.calls.flatMap((call) => call.conditions.map((c) => c.text)) };
  };

  it("lists every published version with its date", async () => {
    const rule = await create();
    await publish(rule.id);
    await reword(rule.id, "Second wording.");
    await publish(rule.id);
    await reword(rule.id, "A draft, not a version.");

    const detail = await app.json<RuleDetail>("GET", `/api/rules/${rule.id}`);
    expect(detail.versions).toEqual([
      expect.objectContaining({ number: 2, instruction: "Second wording.", publishedAt: expect.any(String) }),
      expect.objectContaining({ number: 1, instruction: newRule.instruction, publishedAt: expect.any(String) }),
    ]);
  });

  it("starts a draft from an old version", async () => {
    const rule = await create();
    await publish(rule.id);
    await reword(rule.id, "Second wording.");
    await publish(rule.id);

    const detail = await app.json<RuleDetail>("POST", `/api/rules/${rule.id}/versions/1/draft`, {});
    expect(detail).toMatchObject({ live: { number: 2 }, draft: { instruction: newRule.instruction } });
    expect((await app.call("POST", `/api/rules/${rule.id}/versions/7/draft`, {})).status).toBe(404);
  });

  it("discards a draft", async () => {
    const rule = await create();
    await publish(rule.id);
    await reword(rule.id, "Second wording.");

    const detail = await app.json<RuleDetail>("DELETE", `/api/rules/${rule.id}/draft`);
    expect(detail).toMatchObject({ hasDraft: false, draft: null, live: { instruction: newRule.instruction } });
    expect((await app.call("DELETE", `/api/rules/${rule.id}/draft`)).status).toBe(400);
  });

  it("switches a rule off, so it is never sent to Jev, and on again with its history", async () => {
    const rule = await create();
    await publish(rule.id);
    await reword(rule.id, "Second wording.");
    await publish(rule.id);
    expect((await sentToJev()).conditions).toEqual(newRule.conditions);

    const off = await app.json<RuleDetail>("POST", `/api/rules/${rule.id}/off`, {});
    expect(off).toMatchObject({ state: "off", on: false });
    await create({ name: "Never published" });
    expect(await names("?state=off")).toEqual([newRule.name]);
    expect(await names("?state=live&state=off")).toEqual([newRule.name]);
    expect(await names("?state=draft&state=off")).toEqual([newRule.name, "Never published"]);
    expect(await sentToJev()).toEqual({ output: "", conditions: [] });

    const on = await app.json<RuleDetail>("POST", `/api/rules/${rule.id}/on`, {});
    expect(on).toMatchObject({ state: "live", on: true });
    expect(on.versions.map((v) => v.number)).toEqual([2, 1]);
    const { output } = await sentToJev();
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain("Second wording.");
  });

  it("deletes a rule", async () => {
    const rule = await create();
    await publish(rule.id);

    expect(await app.json("DELETE", `/api/rules/${rule.id}`)).toEqual({ deleted: true });
    expect((await app.call("GET", `/api/rules/${rule.id}`)).status).toBe(404);
    expect(await list()).toEqual([]);
    expect(await sentToJev()).toEqual({ output: "", conditions: [] });
    expect((await app.call("DELETE", `/api/rules/${rule.id}`)).status).toBe(404);
  });
});

describe("a rule's scope", () => {
  /** Records a project by running a check in a plain folder; returns its name. */
  async function see(name: string): Promise<string> {
    const cwd = join(sandbox.root, name);
    mkdirSync(cwd, { recursive: true });
    await runMessageHook(hookInput("hello there", { cwd }), { env: sandbox.env, matcher: standInMatcher() });
    return cwd;
  }

  it("lists the projects Sally has seen, to pick from", async () => {
    expect(await app.json("GET", "/api/projects")).toEqual({ projects: [] });
    const project = await see("a-project");

    const { projects } = await app.json<{ projects: { name: string; firstSeenAt: string }[] }>("GET", "/api/projects");

    expect(projects).toMatchObject([{ name: project }]);
  });

  it("edits the scope in the draft and puts it live on publish", async () => {
    const project = await see("a-project");
    const rule = await create();
    expect(rule.draft).toMatchObject({ scope: { kind: "all" } });
    await app.json("POST", `/api/rules/${rule.id}/publish`, {});

    const saved = await app.json<RuleDetail>("PUT", `/api/rules/${rule.id}/draft`, {
      instruction: newRule.instruction,
      conditions: newRule.conditions,
      scope: { kind: "projects", projects: [project] },
    });
    expect(saved).toMatchObject({ live: { scope: { kind: "all" } }, draft: { scope: { kind: "projects", projects: [project] } } });

    const published = await app.json<{ rule: RuleDetail }>("POST", `/api/rules/${rule.id}/publish`, {});
    expect(published.rule.live).toMatchObject({ scope: { kind: "projects", projects: [project] } });
  });

  it("refuses a malformed scope and a project Sally has not seen", async () => {
    const rule = await create();
    const save = (scope: unknown) =>
      app.call("PUT", `/api/rules/${rule.id}/draft`, { instruction: "X.", conditions: ["Y."], scope });

    expect((await save("all")).status).toBe(400);
    expect((await save({ kind: "projects", projects: [1] })).status).toBe(400);
    const unseen = await save({ kind: "projects", projects: ["never/seen"] });
    expect(unseen.status).toBe(400);
    expect(await unseen.json()).toEqual({ error: 'Sally has not seen a project named "never/seen".' });
  });
});

describe("activity and analytics over HTTP", () => {
  it("serves recent checks and a rule's analytics, and refuses an unknown outcome", async () => {
    const created = await create();
    await app.json("POST", `/api/rules/${created.id}/publish`, {});
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.9 });
    await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });

    const { checks } = await app.json<{ checks: { text: string; outcome: string }[] }>(
      "GET",
      "/api/activity?outcome=attached&checkType=message&limit=10",
    );
    expect(checks).toMatchObject([{ text: "Make the header smaller", outcome: "attached" }]);
    expect((await app.call("GET", "/api/activity?outcome=maybe")).status).toBe(400);
    expect((await app.call("GET", "/api/activity?limit=lots")).status).toBe(400);

    const analytics = await app.json("GET", `/api/rules/${created.id}/analytics`);
    expect(analytics).toMatchObject({ checks: 1, matches: 1, versions: [{ number: 1, matches: 1 }] });
    expect((await app.call("GET", "/api/rules/999/analytics")).status).toBe(404);
  });

  it("serves the rules that need attention, each with why", async () => {
    const created = await create();
    await app.json("POST", `/api/rules/${created.id}/publish`, {});
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.9 });
    await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });

    const { rules } = await app.json<{ rules: unknown[] }>("GET", "/api/attention");
    expect(rules).toMatchObject([
      { ruleId: created.id, name: "Local link first", reasons: [{ kind: "matches_often", matches: 1, checks: 1 }] },
    ]);
  });

  it("clears an attention reason the user judged fine, and refuses what cannot be cleared", async () => {
    const created = await create();
    await app.json("POST", `/api/rules/${created.id}/publish`, {});
    const matcher = standInMatcher({ "The message asks for a visual change.": 0.9 });
    await runMessageHook(hookInput("Make the header smaller"), { env: sandbox.env, matcher });
    const looksFine = (id: number, body: unknown) => app.call("POST", `/api/rules/${id}/looks-fine`, body);

    expect((await looksFine(created.id, { reason: "wrong_matches" })).status).toBe(400);
    expect((await looksFine(created.id, { reason: "looks_odd" })).status).toBe(400);
    expect((await looksFine(created.id, {})).status).toBe(400);
    expect((await looksFine(created.id, { reason: "never_matches" })).status).toBe(400);
    expect((await looksFine(999, { reason: "matches_often" })).status).toBe(404);
    expect((await app.json<{ rules: unknown[] }>("GET", "/api/attention")).rules).toHaveLength(1);

    const cleared = await app.json<{ rules: unknown[] }>("POST", `/api/rules/${created.id}/looks-fine`, {
      reason: "matches_often",
    });
    expect(cleared.rules).toEqual([]);
    expect((await app.json<{ rules: unknown[] }>("GET", "/api/attention")).rules).toEqual([]);
  });
});
