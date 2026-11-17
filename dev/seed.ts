import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runMessageHook } from "../src/message-hook.ts";
import { databasePath } from "../src/paths.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { type CheckType, createRulesService, type RulesService, type Scope } from "../src/rules.ts";
import { openStore } from "../src/store.ts";
import { devMatcher } from "./matcher.ts";

/**
 * Fills `root` with sample data: two made-up projects, rules in every state,
 * message and reply checks, flags and saved cases. Everything goes through
 * the hooks and the rules service, as real use would. Replaces what is there.
 */
export async function seed(root: string): Promise<void> {
  rmSync(root, { recursive: true, force: true });
  const env = { HOME: join(root, "home"), SALLY_DATA_DIR: join(root, "data"), SALLY_CONFIG_DIR: join(root, "config") };
  mkdirSync(env.HOME, { recursive: true });

  const repo = (name: string, remote: string) => {
    const path = join(root, "repos", name);
    mkdirSync(path, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
    git("init", "--quiet", "--initial-branch=main");
    git("remote", "add", "origin", remote);
    return path;
  };
  const alpha = repo("alpha", "git@github.com:example/alpha.git");
  const beta = repo("beta", "git@github.com:example/beta.git");

  const withRules = <T>(use: (rules: RulesService) => T): T => {
    const store = openStore(databasePath(env));
    try {
      return use(createRulesService(store));
    } finally {
      store.close();
    }
  };

  const matcher = devMatcher({ bigTokens: (text) => text.includes("huge pasted log") });
  let count = 0;
  const message = (prompt: string, cwd = alpha, session = "session-a") =>
    runMessageHook(
      JSON.stringify({
        session_id: session,
        transcript_path: "/nonexistent",
        cwd,
        hook_event_name: "UserPromptSubmit",
        prompt: `${prompt} (#${++count})`,
      }),
      { env, matcher },
    );
  const reply = (text: string, cwd = alpha, session = "session-a") =>
    runReplyHook(
      JSON.stringify({
        session_id: session,
        cwd,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: text,
      }),
      { env, matcher },
    );

  // A check in each project, so scope can name them.
  await message("hello", alpha);
  await message("hello", beta);

  const commits = withRules((rules) => {
    rules.updateSettings({ recentChecks: 40, quietChecks: 15, busyShare: 0.3, closeMargin: 0.05 });
    const live = (name: string, checkType: CheckType, instruction: string, conditions: string[], scope?: Scope) => {
      const { ruleId } = rules.createRule({ name, checkType, instruction, conditions, ...(scope ? { scope } : {}) });
      rules.publish(ruleId);
      return ruleId;
    };
    const commits = live("Commit messages", "message", "Use Conventional Commits: type(scope): summary.", [
      "The user asks to write or make a git commit.",
    ]);
    // A second version and a waiting draft, for the version history.
    rules.saveDraft(commits, {
      instruction: "Use Conventional Commits: type(scope): summary, imperative and lowercase. Say why in the body.",
      conditions: ["The user asks to write or make a git commit.", "The user asks for a commit message."],
    });
    rules.publish(commits);
    rules.saveDraft(commits, {
      instruction: "Use Conventional Commits. Keep the summary under 72 characters.",
      conditions: ["The user asks to write or make a git commit."],
    });
    live("Answer briefly", "message", "Start with a short answer of a few lines.", [
      "The user asks a short answer question.",
      "The user wants a brief reply.",
    ]);
    live(
      "Database migrations",
      "message",
      "Write a reversible migration and say how to roll back.",
      ["The message is about a database migration or schema change."],
      { kind: "projects", projects: ["example/alpha"] },
    );
    live("Release notes", "message", "Write release notes for users, not developers.", [
      "The user asks for release notes.",
    ]);
    rules.switchOff(
      live("Old style guide", "message", "Follow the old style guide.", ["The message is about the style guide."]),
    );
    live("Run the tests", "message", "Run the tests for what changed before saying it works.", [
      "The user asks to test a change.",
    ]);
    live("Deploy checklist", "message", "Check the deploy checklist first.", ["The user asks to deploy."]);
    live("No apologies", "reply", "Do not apologise; state the fix.", ["The reply apologises to the user."]);
    rules.createRule({
      name: "Ask before pushing",
      checkType: "message",
      instruction: "Ask before pushing to a shared branch.",
      conditions: ["The user asks to push."],
    });
    return commits;
  });

  const prompts = [
    "how do I rename a branch?",
    "quick question about vite?",
    "please commit this",
    "add a migration for the users table",
    "how does the cutoff work?",
    "commit and test and deploy this please, how?",
    "write a commit message for the schema migration",
    "/review commit the fix for the login test now please",
    "/clear",
    "email me at someone@example.com about the commit",
    "update the style guide",
    "how do I run it?",
    "here is a huge pasted log, how do I read it?",
    "test the parser",
    "deploy to staging",
    "what changed?",
    "how long will it take?",
    "add an index to the orders table",
    "quick: how to undo a commit?",
    "thanks",
  ];
  for (const prompt of prompts) await message(prompt);
  for (const prompt of ["add a migration to beta", "how do I list tables?", "commit this in beta"]) {
    await message(prompt, beta, "session-b");
  }

  await reply("Sorry about that, I fixed the import.");
  await reply("Fixed the import; tests pass.");
  await reply("Apologies, the build broke again.", beta, "session-b");

  // Flags: one raised by Claude, two by the user.
  const store = openStore(databasePath(env));
  const matches = store.prepare("SELECT id FROM matches WHERE rule_id = ? ORDER BY id").all(commits) as { id: number }[];
  store.close();
  withRules((rules) => {
    rules.reportWrongMatch("session-a", "Answer briefly");
    if (matches[0]) rules.flagMatch(matches[0].id, "right", "user");
    if (matches[1]) rules.flagMatch(matches[1].id, "wrong", "user");
  });
}
