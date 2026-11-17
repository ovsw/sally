import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageHook } from "../src/message-hook.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { folder, gitConfig, gitRepo, gitWorktree } from "./support/git.ts";
import { createSandbox, hookInput, type Sandbox } from "./support/sandbox.ts";
import { type StandIn, standInMatcher } from "./support/stand-in-matcher.ts";

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

/** Runs a message check in `cwd` (or with no folder at all, when undefined). */
const messageIn = (cwd: string | undefined, matcher: StandIn = standInMatcher(), prompt = "hello there") =>
  runMessageHook(hookInput(prompt, { cwd }), { env: sandbox.env, matcher });

/** Each check's project name, in order; null for a check with no project. */
const checkProjects = () =>
  sandbox
    .query<{ project: string | null }>(
      "SELECT p.name AS project FROM checks c LEFT JOIN projects p ON p.id = c.project_id ORDER BY c.id",
    )
    .map((row) => row.project);

const projects = () => sandbox.query<{ name: string; first_seen_at: string }>("SELECT * FROM projects ORDER BY id");

/** The condition texts each matcher call was sent. */
const sentConditions = (matcher: StandIn) => matcher.calls.map((call) => call.conditions.map((c) => c.text).sort());

describe("the project of a check", () => {
  it("is the same project for two worktrees of one repository and a subfolder of either", async () => {
    const repo = gitRepo(join(sandbox.root, "repo"), { origin: "git@github.com:Owner/Repo.git" });
    const worktree = gitWorktree(repo, join(sandbox.root, "repo-worktree"));

    await messageIn(repo);
    await messageIn(worktree);
    await messageIn(folder(worktree, "src", "deep"));

    expect(checkProjects()).toEqual(["owner/repo", "owner/repo", "owner/repo"]);
    expect(projects()).toMatchObject([{ name: "owner/repo" }]);
  });

  it.each([
    ["git@github.com:Owner/Repo.git"],
    ["https://github.com/owner/repo.git"],
    ["https://user:secret@github.com/owner/repo/"],
    ["ssh://git@github.com:22/owner/repo.git"],
    ["https://gitlab.example.com/group/owner/repo"],
  ])("names the repository by its remote %s as owner and name", async (url) => {
    await messageIn(gitRepo(join(sandbox.root, "repo"), { origin: url }));

    expect(checkProjects()).toEqual(["owner/repo"]);
  });

  it("prefers the origin remote, and takes another when there is no origin", async () => {
    await messageIn(
      gitRepo(join(sandbox.root, "both"), { fork: "git@github.com:me/fork.git", origin: "git@github.com:owner/main.git" }),
    );
    await messageIn(gitRepo(join(sandbox.root, "fork-only"), { upstream: "git@github.com:owner/other.git" }));

    expect(checkProjects()).toEqual(["owner/main", "owner/other"]);
  });

  it("finds a remote set in a file the repository's config includes", async () => {
    const repo = gitRepo(join(sandbox.root, "repo"));
    const included = join(sandbox.root, "remotes.gitconfig");
    writeFileSync(included, '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n');
    gitConfig(repo, "include.path", included);

    await messageIn(repo);

    expect(checkProjects()).toEqual(["owner/repo"]);
  });

  it("is the folder path outside any repository", async () => {
    const plain = folder(sandbox.root, "plain", "folder");

    await messageIn(plain);

    expect(checkProjects()).toEqual([plain]);
  });

  it("is the repository's main folder when it has no remote, from any of its worktrees", async () => {
    const repo = gitRepo(join(sandbox.root, "local"));
    const worktree = gitWorktree(repo, join(sandbox.root, "local-worktree"));

    await messageIn(repo);
    await messageIn(worktree);

    expect(checkProjects()).toEqual([realpathSync(repo), realpathSync(repo)]);
  });

  it("is recorded once, when first seen, and on every kind of check", async () => {
    const repo = gitRepo(join(sandbox.root, "repo"), { origin: "git@github.com:owner/repo.git" });

    await messageIn(repo); // fails: no live rules
    const [first] = projects();
    sandbox.liveRule({ name: "A rule", conditions: ["Condition A."] });
    await messageIn(repo, standInMatcher({ "Condition A.": 0.9 })); // attached
    await messageIn(repo, standInMatcher(), "/review"); // skipped: a bare slash command
    await runReplyHook(JSON.stringify({ session_id: "s", cwd: repo, stop_hook_active: true, last_assistant_message: "Done." }), {
      env: sandbox.env,
      matcher: standInMatcher(),
    }); // skipped by the guard

    expect(sandbox.query<{ outcome: string }>("SELECT outcome FROM checks ORDER BY id").map((c) => c.outcome)).toEqual([
      "failed",
      "attached",
      "skipped",
      "skipped",
    ]);
    expect(checkProjects()).toEqual(["owner/repo", "owner/repo", "owner/repo", "owner/repo"]);
    expect(projects()).toEqual([first]);
  });

  it("is none for a check with no folder", async () => {
    await messageIn(undefined);

    expect(checkProjects()).toEqual([null]);
    expect(projects()).toEqual([]);
  });
});

describe("rule scope", () => {
  /** Two seen projects, and a rule for all projects plus one limited to the first project. */
  async function setUp() {
    const repo = gitRepo(join(sandbox.root, "repo"), { origin: "git@github.com:owner/repo.git" });
    const worktree = gitWorktree(repo, join(sandbox.root, "repo-worktree"));
    const elsewhere = folder(sandbox.root, "elsewhere");
    await messageIn(repo);
    await messageIn(elsewhere);
    sandbox.liveRule({ name: "Everywhere", conditions: ["Everywhere condition."] });
    sandbox.liveRule({
      name: "Only repo",
      conditions: ["Repo condition."],
      scope: { kind: "projects", projects: ["owner/repo"] },
    });
    return { repo, worktree, elsewhere };
  }

  it("sends only the in-scope live rules to the matcher", async () => {
    const { repo, worktree, elsewhere } = await setUp();
    const matcher = standInMatcher();

    await messageIn(repo, matcher);
    await messageIn(worktree, matcher);
    await messageIn(elsewhere, matcher);
    await messageIn(undefined, matcher);

    expect(sentConditions(matcher)).toEqual([
      ["Everywhere condition.", "Repo condition."],
      ["Everywhere condition.", "Repo condition."],
      ["Everywhere condition."],
      ["Everywhere condition."],
    ]);
  });

  it("never fires an out-of-scope rule, and records no score for it", async () => {
    const { elsewhere } = await setUp();
    const matcher = standInMatcher({ "Repo condition.": 0.99 });

    expect(await messageIn(elsewhere, matcher)).toBe("");
    expect(sandbox.query("SELECT * FROM scores s JOIN conditions c ON c.id = s.condition_id WHERE c.text = 'Repo condition.'")).toEqual(
      [],
    );
  });

  it("applies to reply checks too", async () => {
    const { elsewhere } = await setUp();
    sandbox.liveRule({
      name: "Repo reply",
      checkType: "reply",
      conditions: ["Reply condition."],
      scope: { kind: "projects", projects: ["owner/repo"] },
    });
    const matcher = standInMatcher({ "Reply condition.": 0.99 });

    const output = await runReplyHook(
      JSON.stringify({ session_id: "s", cwd: elsewhere, stop_hook_active: false, last_assistant_message: "Done." }),
      { env: sandbox.env, matcher },
    );

    expect(output).toBe("");
    expect(matcher.calls).toEqual([]);
  });

  it("changes only when the draft holding the new scope is published", async () => {
    const { elsewhere } = await setUp();
    const [{ id }] = sandbox.query<{ id: number }>("SELECT id FROM rules WHERE name = 'Only repo'") as [{ id: number }];
    const matcher = standInMatcher();

    sandbox.withRules((rules) =>
      rules.saveDraft(id, { instruction: "Do it.", conditions: ["Repo condition."], scope: { kind: "all" } }),
    );
    await messageIn(elsewhere, matcher);
    sandbox.withRules((rules) => rules.publish(id));
    await messageIn(elsewhere, matcher);

    expect(sentConditions(matcher)).toEqual([["Everywhere condition."], ["Everywhere condition.", "Repo condition."]]);
  });
});
