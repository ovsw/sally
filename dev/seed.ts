import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMessageHook } from "../src/message-hook.ts";
import { createImportService } from "../src/import.ts";
import { databasePath, type Env } from "../src/paths.ts";
import { runReplyHook } from "../src/reply-hook.ts";
import { type CheckType, conditionsFor, createRulesService, type RulesService, type Scope } from "../src/rules.ts";
import { openStore } from "../src/store.ts";
import { devMatcher } from "./matcher.ts";

/** The sample data's home, data and config folders, all under `root`. */
export function devEnv(root: string): Env & { HOME: string } {
  return { HOME: join(root, "home"), SALLY_DATA_DIR: join(root, "data"), SALLY_CONFIG_DIR: join(root, "config") };
}

/** An invented project rules file for the sample import. */
const SAMPLE_RULES_FILE = `# Alpha

Answer in plain words, and keep replies short.

## Screenshots

When a page's layout changes, take a full-page screenshot and put it next to
the reference before calling it done.

## Checks

Before a commit, run the linter. Before a release, run the full suite.

Be careful with the database.

Ask before you push.
`;

/**
 * Fills `root` with sample data: two made-up projects, rules in every state,
 * message and reply checks, and false positives. Everything goes through
 * the hooks and the rules service, as real use would. Replaces what is there.
 */
/** A message with a long pasted log: the check behind the large request on the Settings screen. */
const HUGE_LOG =
  "here is a huge pasted log, how do I read it?\n" +
  Array.from(
    { length: 1_500 },
    (_, i) => `2026-11-17T08:${String(i % 60).padStart(2, "0")}:00Z worker-${i % 8} INFO job ${i} done in ${i % 97} ms`,
  ).join("\n");

export async function seed(root: string): Promise<void> {
  rmSync(root, { recursive: true, force: true });
  const env = devEnv(root);
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

  const { commits, localLink } = withRules((rules) => {
    rules.updateSettings({ recentChecks: 40, quietChecks: 15, busyShare: 0.3, closeMargin: 0.05 });
    const live = (name: string, checkType: CheckType, instruction: string, conditions: string[], scope?: Scope) => {
      const { ruleId } = rules.createRule({
        name,
        instruction,
        conditions: conditionsFor(checkType, conditions),
        ...(scope ? { scope } : {}),
      });
      rules.publish(ruleId);
      return ruleId;
    };
    const commits = live("Commit messages", "message", "Use Conventional Commits: type(scope): summary.", [
      "The user asks to write or make a git commit.",
    ]);
    // A second version and a waiting draft, for the version history.
    const [first] = rules.getRule(commits).live!.conditions;
    rules.saveDraft(commits, {
      instruction: "Use Conventional Commits: type(scope): summary, imperative and lowercase. Say why in the body.",
      conditions: [first!, { text: "The user asks for a commit message.", message: true, reply: false }],
    });
    rules.publish(commits);
    rules.saveDraft(commits, {
      instruction: "Use Conventional Commits. Keep the summary under 72 characters.",
      conditions: [first!],
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
    // One rule in both checks: a condition for the message and one for the reply.
    const { ruleId: localLink } = rules.createRule({
      name: "Local link before a PR",
      instruction: "Before opening a pull request for a visual change, give the localhost link and wait for an OK.",
      conditions: [
        { text: "The message asks for a visual change to a page.", message: true, reply: false },
        { text: "The reply reports a finished visual change and gives no local link.", message: false, reply: true },
      ],
    });
    rules.publish(localLink);
    rules.createRule({
      name: "Ask before pushing",
      instruction: "Ask before pushing to a shared branch.",
      conditions: conditionsFor("message", ["The user asks to push."]),
    });
    return { commits, localLink };
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
    HUGE_LOG,
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

  // The rule in both checks matches on a message and on the reply of the same turn.
  await message("make the header smaller");
  await reply("Done, the header is smaller.");

  // False positives: one marked by Claude, three by the user.
  const store = openStore(databasePath(env));
  const matchesOf = (ruleId: number) =>
    store.prepare("SELECT id FROM matches WHERE rule_id = ? ORDER BY id").all(ruleId) as { id: number }[];
  const matches = matchesOf(commits);
  // A message and a reply for the rule in both checks.
  const localLinkMatches = matchesOf(localLink);
  store.close();
  withRules((rules) => {
    rules.reportFalsePositive("session-a", "Answer briefly");
    if (matches[1]) rules.markFalsePositive(matches[1].id, "user");
    for (const match of localLinkMatches) rules.markFalsePositive(match.id, "user");
  });

  // An import of alpha's rules file, with a passage of each verdict, waiting for review.
  const rulesFile = join(alpha, "CLAUDE.md");
  writeFileSync(rulesFile, SAMPLE_RULES_FILE);
  const importStore = openStore(databasePath(env));
  try {
    const imports = createImportService(importStore, { env });
    const { id } = imports.startImport(rulesFile);
    imports.addPassages(id, [
      {
        text: "Answer in plain words, and keep replies short.",
        verdict: "always_rule",
        reason:
          "This applies to every reply, whatever the message is about. A rule that always applies has no condition to check, so it stays in the rules file, where Claude reads it every time.",
      },
      {
        text: "## Screenshots\n\nWhen a page's layout changes, take a full-page screenshot and put it next to\nthe reference before calling it done.",
        verdict: "becomes_rule",
        reason:
          "Only some turns change a page's layout. Sally can recognise that in the message that asks for it and in the reply that reports it, so one rule with a condition for each reaches Claude only then.",
        rules: [
          {
            name: "Screenshot changed pages",
            instruction:
              "Take a full-page screenshot of the changed page, put it next to the reference and compare them before saying it is done.",
            conditions: [
              { text: "The message asks to change a page's layout or styles.", message: true, reply: false },
              { text: "The reply says a page's layout or styles were changed.", message: false, reply: true },
            ],
          },
        ],
      },
      {
        text: "Before a commit, run the linter. Before a release, run the full suite.",
        verdict: "becomes_rule",
        reason:
          "Two situations share one sentence. Each gets its own rule, so each condition can be short and concrete.",
        rules: [
          {
            name: "Lint before a commit",
            instruction: "Run the linter before making the commit, and fix what it finds.",
            conditions: ["The user asks to write or make a git commit."],
          },
          {
            name: "Full suite before a release",
            instruction: "Run the full test suite before preparing the release.",
            conditions: ["The user asks to prepare or publish a release."],
          },
        ],
      },
      {
        text: "Be careful with the database.",
        verdict: "too_vague",
        reason:
          "No message is clearly about being careful, so a condition could not pick out when this applies. Say what careful means, and when, and it can become a rule.",
      },
      {
        text: "Ask before you push.",
        verdict: "becomes_rule",
        reason: "Only messages that lead to a push need this, which a condition can recognise.",
        similarRule: 'Looks like your rule "Ask before pushing".',
        rules: [
          {
            name: "Ask before a push",
            instruction: "Ask the user before pushing to the remote.",
            conditions: ["The user asks to push commits to the remote."],
          },
        ],
      },
    ]);
  } finally {
    importStore.close();
  }
}
