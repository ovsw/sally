# Sally

Sally is a tool that decides, on every turn, which of your written rules
Claude Code needs to see right now, and shows it only those.

Status: early, and built for one person's use. No guarantees.

## The problem it solves

1. You give Claude Code rules in CLAUDE.md files, and in its memory.
2. Every rule is loaded into every session, and Claude still skips them.
3. With dozens of rules in view, the one that matters for the current message
   does not stand out.
4. Adding more rules makes it worse, so each new rule weakens the others.
5. You also cannot see which rules ever come into play.

**In short, agents have a working memory problem.** Working memory is the
part of everything the agent knows that it is applying to the task and the
conversation at hand. Storing something in CLAUDE.md or in the memory files
does not put it in working memory, and that causes most of the problems in
agentic workflows today.

## The proposed solution

1. Turn off project memory.
2. Keep CLAUDE.md **only for rules that always apply** to how you want Claude
   to work with you (for example "answer briefly").
3. Build a list of conditional rules ("in situation X, do Y").
4. Use a **salience engine** (Sally) to pick the rules that are relevant
   (salient) at each step of a conversation, and hand the agent exactly
   those.

### The obstacle

Deciding whether a rule applies at the current point in a chat is slow and
costly for most models. System Two models, such as Claude and ChatGPT, are a
poor fit for it.

The two names come from psychology, where they describe two ways of
thinking:

- **System One** is fast and automatic: a gut reaction. A System One model
  answers a narrow question, such as "does this condition hold?", with a
  score, in a fraction of a second.
- **System Two** is slow and deliberate: working a problem through step by
  step. A System Two model reasons and writes its answer out one token at a
  time.

### System One models to the rescue

System One models are good at exactly this task:

| | System One (for example Jev) | System Two (for example Claude, ChatGPT) |
| :- | :- | :- |
| **Core function** | Fast classification, scoring and routing. | Deep reasoning, writing, coding and conversation. |
| **Output** | Structured values and calibrated probabilities. | Free-form text or code, written token by token. |
| **Speed and cost** | Very fast (70 to 500 ms) and cheap. | Slower (seconds to minutes) and heavier. |
| **Analogy** | Gut instinct, a reflex check. | Deliberate, step-by-step problem solving. |
| **How it works** | In parallel: many independent questions at once. | In sequence: one token after another. |

## The idea

A **rule** in Sally has two parts:

- **Condition:** a short statement that is true or false of a piece of text,
  for example "The user asks to write a git commit."
- **Instruction:** what Claude should do when the condition holds, for
  example "Use Conventional Commits."

On every turn:

1. Sally asks Jev, a System One model from TypeSafe, how likely each
   condition is to hold.
2. Jev returns a **score** from 0 to 1 for each one.
3. If a score reaches the **cutoff** (0.6 by default), the rule **matches**,
   and Claude receives its instruction word for word.
4. If nothing matches, Sally says nothing. That silence is the point: an
   instruction that appears only when it applies gets taken seriously.

A conditional rule lives only in Sally, in a local database, and not in
CLAUDE.md as well ([why](docs/adr/0001-conditional-rules-live-only-in-sally.md)).
CLAUDE.md keeps the rules that always apply, plus one line telling Claude
that the rules Sally hands it are yours and carry the same authority.

The words used here are defined in [GLOSSARY.md](GLOSSARY.md).

## The two moments it acts

- **Message check:** when you send a message, Sally scores it and attaches
  the matching instructions to it before Claude starts work.
- **Reply check:** when Claude finishes its reply, Sally scores that reply.
  On a match, Claude gets the instruction and one chance to revise before the
  turn ends. The same turn is never sent back twice.

## How matching behaves

- **Several conditions per rule:** a rule matches when any one of its
  conditions reaches the cutoff.
- **No cap:** every rule that matches reaches Claude, strongest first.
- **Slash commands:** the command name is removed before checking, so only
  the text you typed with it is judged. A bare command like `/clear` is
  skipped.
- **Privacy:** email addresses are masked before text goes to Jev. Jev sees
  conditions, never instructions.
- **Pasted text:** in T3 Code, which marks what you paste, a pasted document,
  log or transcript is left out of the message check, with a note such as
  `[pasted text left out: 1,500 lines]` in its place. Rules are checked
  against what you wrote, and the paste neither goes to Jev nor lands in the
  database. Plain Claude Code does not mark pastes, so there they are checked
  like the rest of the message.
- **Long text:** a text too long for Jev keeps its start and its end and loses
  its middle, since a request usually comes before or after a long passage.
  The cut is recorded.
- **Project scope:** a rule applies to all projects or only to the ones you
  pick. A project is the git repository the session runs in.

## When a check fails

A check fails when Sally cannot get scores from Jev: no API key, a network
error, no answer within the time limit, or an answer it cannot read. A turn
that goes through without your rules is a compromised turn, so Sally stops it
rather than let it pass. Apart from a missing API key, scoring is tried once
more first, with the full time limit again.

- **Message check:** the message is not sent to Claude. You see why, and
  sending the message again retries.
- **Reply check:** the reply is already written, so it stands; you get a
  warning that it was not checked. Claude is not made to continue.

To let turns through when a check fails, switch off "Stop the turn when a
check fails" on the Settings screen, or run this in Sally's folder:

```sh
node src/cli.ts settings stop-on-failure off   # on switches it back; no value shows it
```

Having no published rules switched on is not a failure: nothing is asked of
Jev and nothing matched. And a Sally that is itself broken (its database cannot be opened,
say) never blocks you: the turn goes through, with a warning.

## Tending the rules: the web app

Run this in Sally's folder:

```sh
node src/cli.ts app            # or: node src/cli.ts app --port N
```

It prints its address (`http://127.0.0.1:4517` by default; `--port` or
`SALLY_PORT` changes it) and is reachable only from your machine. It has five
screens:

- **Needs attention:** rules that deserve a look, worst first. A rule lands
  here for matches flagged as wrong, for matching often, for weak matches
  (scores just over the cutoff), or for never matching. When you have looked
  at a reason and the rule is doing what you want, **Looks fine** clears that
  one reason for that rule until its next version is published. Wrong matches
  have no such button: they go when the rule is fixed.
- **Rules:** a searchable, filterable list. Each rule has a switch to turn it
  on or off, a green light when it is published and a yellow one when it has
  a draft, the checks it takes part in (user message, agent reply or both),
  and its scope (all projects, or the projects it is for).
- **Rule:** opens in a panel beside the list: the published version beside
  its draft; conditions, each with a Message and a Reply switch for the checks
  that use it, instruction, scope and an on/off switch; version
  history with how each version performed; its matches, near misses and saved
  cases.
- **Activity:** recent checks, newest first, with the text checked, the
  outcome, and which rules matched with what scores.
- **Settings:** see below.

The command builds the app into `dist/web` when the build is missing or older
than its sources.

### Drafts and versions

- **Drafts:** edits save automatically into a draft and change nothing until
  you publish.
- **Publishing:** makes the draft the new **published version**, which takes
  effect on the next check while the rule is on.
- **History:** published versions never change. You can start a new draft
  from an old one.
- **Switching off:** stops a rule matching without deleting it. It is separate
  from publishing: a rule switched off keeps its published version and draft.
- **Condition switches:** a published condition's Message and Reply switches
  take effect at once, with no draft and no new version. A condition with both
  off is not checked. Switching off a rule's last condition that is on
  switches the rule off; switching a condition back on leaves the rule off
  until you switch it on, which needs at least one condition on.

### Settings

| Setting | Default | What it does |
| :- | :- | :- |
| **Message cutoff** | 0.6 | The score a condition must reach for its rule to match in a message check. Raise it if rules match when they should not; lower it if they are missed. |
| **Reply cutoff** | 0.6 | The same for a reply check. A match there makes Claude write a whole extra reply, so it is worth setting higher if replies are sent back when they did not break the rule. |
| **Time limit** | 10,000 ms | How long a check waits for Jev before giving up. At most 10 seconds, so that two tries fit inside the 30 seconds Claude Code gives a hook. |
| **Stop the turn when a check fails** | On | See [When a check fails](#when-a-check-fails). |
| **Recent checks** | 100 | How many of the latest checks count as recent for the settings below. |
| **Matches often** | 30% | A rule matching on at least this share of recent checks is listed as needing attention: its condition may be too broad, or it may really be a rule that always applies. |
| **Weak matches** | 0.05 | A match scoring no more than this above the cutoff counts as a weak match. |
| **Never matches** | 200 checks | A rule with no match over this many checks of its type is listed as needing attention. |

The screen also shows how much of Jev's request size limit your rules use.
When the conditions no longer fit one request, they are split across parallel
requests.

## Wrong matches

A **wrong match** is a rule that matched when it did not apply. It is the
most damaging failure, because it teaches Claude to discount everything Sally
hands it. A **miss**, a rule that applied and did not match, is easier to live
with.

- **Flagging:** on a rule's page, one click marks a match wrong and one marks
  it right. A match with no flag counts as right, so you never have to mark
  them all.
- **Claude can report one too.** Sally's output ends with a line telling
  Claude how. The command names Sally's command line by its full path, so it
  runs from the folder Claude is working in:

  ```sh
  node "<Sally's folder>/src/cli.ts" wrong-match "<rule name>"
  ```

  It flags the session's most recent match of that rule as a wrong match
  raised by Claude. The session is the one Claude Code runs the command in
  (`CLAUDE_CODE_SESSION_ID`); `--session <id>` names another.
- **Saved cases:** every flag keeps that message or reply with the rule,
  marked "should match" or "should not match". A match holds one flag; a new
  one replaces it, but never your own.
- **Re-score before publish:** when you publish a rule that has saved cases,
  the app first asks Jev to score the draft against each case and shows which
  pass, so a fix does not break what worked. You can then publish anyway or
  go back to the draft. If Jev cannot be reached, the app says so and you can
  still publish.

## Install

Sally runs on Linux, macOS and Windows.

### What you need

- **Node 24 or newer.** The database is SQLite, which ships with Node, so
  there is nothing else to set up.
- **git**, to get Sally and because a project is a git repository.
- **Claude Code 2.1.139 or newer.** Install warns you when yours is older.
- **A Jev API key from TypeSafe.** Jev is in early access.

### Steps

The same commands work in a terminal on Linux and macOS and in PowerShell on
Windows.

```sh
git clone https://github.com/ovsw/sally.git
cd sally
node src/cli.ts sally-install
```

Install then walks you through the rest:

1. It checks your Node version.
2. It downloads the dependencies the web app needs, with pnpm if you have it
   and otherwise with pnpm fetched through npm for that one command, so you
   get the tested versions without installing pnpm. This can take a minute.
   If the download fails, install still does everything else and ends with
   the command to retry it.
3. It asks you to paste your API key. What you type is not shown. A key
   already in `TYPESAFE_API_KEY` or in the key file is used instead.
4. It tests the key with one call to Jev. If the test fails it says why, and
   you can paste again or save the key anyway.
5. It saves the key and creates the database.
6. It registers the message hook (`UserPromptSubmit`) and the reply hook
   (`Stop`) in `~/.claude/settings.json`, pointing at this checkout, and adds
   one line to `~/.claude/CLAUDE.md` saying that the rules Sally attaches are
   yours and carry the same authority as that file.
7. It adds the `sally-import` skill to Claude Code.

Sally has no rules yet, so it does nothing until you give it some. In Claude
Code, type `/sally-import` to bring in the rules you already keep in your
rules files; the Guide in the web app (`node src/cli.ts app`) explains the
import and how to write a rule that matches well.

Keep the checkout where it is: the hooks and the skill point at it. If you
move it, run `node src/cli.ts sally-install` again from the new place.

`node src/cli.ts sally-install --yes` asks nothing: it downloads the
dependencies when they are missing, registers the hooks, the authority line
and the skill, and leaves the key to you. Install does the same
when it is not run in a terminal. Running install again changes nothing.

### Uninstall

```sh
node src/cli.ts sally-uninstall
```

Uninstall removes the hooks, the authority line and the skill, and leaves
everything else in those files as it was. It keeps your key and your database
and tells you where they are. Both commands follow `CLAUDE_CONFIG_DIR` when it
is set.

### Where things live

- **API key**: the `TYPESAFE_API_KEY` environment variable, or the file
  `~/.config/sally/api_key`, which install writes readable only by you.
  Without a key, every check that needs Jev fails: any check with a published
  rule switched on for it. See
  [When a check fails](#when-a-check-fails).
- **Database**: `~/.local/share/sally/sally.db` (SQLite). It holds your rules
  and every check, including the full text of your messages, so it never
  belongs in a repository.

- **Backups of rules files**: `~/.local/share/sally/backups/`, made before an
  import removes anything from a rules file.

On Windows `~` is your user folder (`%USERPROFILE%`), and the key file takes
its access from that folder.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` move these folders as usual;
`SALLY_CONFIG_DIR` and `SALLY_DATA_DIR` override them outright.

## The command line

Sally has no command of its own on your PATH. Run its command line with Node
from Sally's folder, as `node src/cli.ts <command>`, or from anywhere with the
full path: `node "<Sally's folder>/src/cli.ts" <command>`.

- **`sally-install` / `sally-uninstall`:** see [Install](#install).
- **`app`:** starts the web app.
- **`settings stop-on-failure [on|off]`:** see
  [When a check fails](#when-a-check-fails).
- **`wrong-match "<rule name>"`:** see [Wrong matches](#wrong-matches).
- **`rules ...`:** lets an agent read your rules and prepare drafts.
- **`import ...`:** what the `sally-import` skill runs to record an
  import, back up a rules file and note that it was cleaned up.
- **`evaluate`:** measures matching against the real Jev.

### Commands for agents

An agent can read your rules and prepare drafts; it cannot publish, switch off
or delete a rule. Those stay with you in the web app, where the agent's drafts
show up like your own. Output is JSON: each rule with its conditions, and each
condition with its Message and Reply switches.

```sh
node src/cli.ts rules list [--search TEXT] [--check-type message|reply] \
  [--published | --unpublished] [--on | --off] [--with-draft | --without-draft]
node src/cli.ts rules show RULE   # id or exact name: published version beside draft
node src/cli.ts rules create --name NAME --check-type message|reply \
  --instruction TEXT --condition TEXT [--condition TEXT ...]
node src/cli.ts rules edit RULE [--name NAME] [--instruction TEXT] \
  [--condition TEXT ... [--check-type message|reply]]
```

`node src/cli.ts rules help` lists every option.

### Evaluation

```sh
node src/cli.ts evaluate FILE [--scale]
```

Runs a file of saved messages and replies, each with the rules expected to
match, through the engine with the real Jev, and reports right matches, wrong
matches and misses, with timing and tokens. `--scale` pads the rule set to
several hundred conditions and leads with the wrong-match rate. It needs an
API key and costs a little, so it runs only on request, never in CI. The file
format is in [docs/evaluation.md](docs/evaluation.md); a file built from real
messages stays outside the repository.

## What it does not do

- It does not import your existing rules from CLAUDE.md; that is a separate
  step you do when you start using it.
- It does not judge whether Claude actually followed a rule it was handed.
- It does not write rules from your corrections.
- It works with Claude Code and Jev only.

## Development

Requires Node 24 or later and pnpm. The command line runs its TypeScript
directly with Node's type stripping; only the web app is built (`pnpm build`).

```sh
pnpm install
pnpm check   # typecheck, lint and tests
```

The user-prompt-submit hook runs `node <checkout>/src/cli.ts hook message`;
the stop hook runs `node <checkout>/src/cli.ts hook reply`.

`pnpm dev` runs the web app with hot reload on sample data: a database in
`.dev/` and a stand-in matcher, so it needs no API key and never touches the
real database. `pnpm dev --fresh` starts the sample data over, and
`pnpm dev --empty` starts with no rules, as a new user sees it.

The advice on writing rules lives in one file,
[`docs/writing-rules.md`](docs/writing-rules.md). The Guide page in the web
app shows it, and the import skill reads it.

The web app is React with shadcn/ui, in `web/`. `pnpm dev:web` serves it with
hot reload and sends `/api` to a running `node src/cli.ts app`. Layouts and components
come from shadcn blocks through the `@shadcnblocks` registry set up in
`components.json`; adding one needs `SHADCNBLOCKS_API_KEY` in the environment
(for example in `.env.local`, which is never committed):

```sh
pnpm dlx shadcn@latest add @shadcnblocks/<block>
```

MIT licensed.
