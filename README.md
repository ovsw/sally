# Sally

A salience engine for Claude Code.

You write rules as a condition and an instruction. On each turn Sally asks a
fast decision model (TypeSafe's Jev) which conditions hold, and hands Claude
only the instructions that apply: before it starts work on your message, and
again when it finishes its reply. When nothing applies, Sally stays silent.

Status: early. The message check works end to end; the rest of the spec is
tracked in this repository's issues.

## Install

```sh
node src/cli.ts install     # from this checkout
node src/cli.ts uninstall   # backs it out
```

Install registers the message hook (`UserPromptSubmit`) and the reply hook
(`Stop`) in `~/.claude/settings.json`, pointing at this checkout, and adds one
line to `~/.claude/CLAUDE.md` saying that the rules Sally attaches are yours and
carry the same authority as that file. Running it again changes nothing.
Uninstall removes exactly those entries. Both leave everything else in the two
files as it was, and both follow `CLAUDE_CONFIG_DIR` when it is set.

## Where things live

- **API key**: the `TYPESAFE_API_KEY` environment variable, or the file
  `~/.config/sally/api_key` (readable only by you: `chmod 600`). Without a key
  every check fails as soon as you have a live rule: see
  [When a check fails](#when-a-check-fails).
- **Database**: `~/.local/share/sally/sally.db` (SQLite). It holds your rules
  and every check, including the full text of your messages, so it never
  belongs in a repository.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` move these folders as usual;
`SALLY_CONFIG_DIR` and `SALLY_DATA_DIR` override them outright.

## The web app

```sh
sally app            # or: node src/cli.ts app [--port N]
```

It prints its address (`http://127.0.0.1:4517` by default; `--port` or
`SALLY_PORT` changes it) and listens on this machine only. Browse and search
your rules, create one, and edit it: edits save into a draft automatically
and change nothing until you publish. The engine uses a published rule from
the next check on.

The command builds the app into `dist/web` when the build is missing or older
than its sources.

## When a check fails

A check fails when Sally cannot get scores from Jev: no API key, a network
error, no answer within the time limit, or an answer it cannot read. Sally
then cannot say whether a rule matched, so it stops the turn rather than let
it through without your rules. Apart from a missing API key, scoring is tried
once more first, with the full time limit again.

- **Message check**: the message is not sent to Claude. You see why, and
  sending the message again retries.
- **Reply check**: the reply is already written, so it stands; you get a
  warning that it was not checked. Claude is not made to continue.

To let turns through when a check fails, as Sally did before, switch off
"Stop the turn when a check fails" on the Settings screen of the web app, or
run:

```sh
sally settings stop-on-failure off   # on switches it back; no value shows it
```

Having no live rules is not a failure: nothing is asked of Jev and nothing
matched. And a Sally that is itself broken (its database cannot be opened,
say) never blocks you: the turn goes through, with a warning.

The time limit can be at most 10 seconds, so that the two tries always fit
inside the 30 seconds Claude Code gives the message hook.

## Commands for agents

An agent can read your rules and prepare drafts; it cannot publish, switch off
or delete a rule. Those stay with you in the web app, where the agent's drafts
show up like your own. Output is JSON.

```sh
sally rules list [--search TEXT] [--check-type message|reply] [--state live|draft]
sally rules show RULE            # id or exact name: live version beside draft
sally rules create --name NAME --check-type message|reply \
  --instruction TEXT --condition TEXT [--condition TEXT ...]
sally rules edit RULE [--name NAME] [--check-type message|reply] \
  [--instruction TEXT] [--condition TEXT ...]
```

`sally rules help` lists every option.

## Wrong matches

Sally's output ends with a line telling Claude how to report a rule that does
not apply:

```sh
sally wrong-match "<rule name>"
```

It flags the session's most recent match of that rule as a wrong match raised
by Claude. The session is the one Claude Code runs the command in
(`CLAUDE_CODE_SESSION_ID`); `--session <id>` names another. On a rule's page
in the app, one click marks a match wrong and one marks it right. Every
flag records who raised it and keeps the text as a saved case for the rule:
a wrong match should not match, a right one should. A match holds one flag;
a new one replaces it, but never your own.

When you publish a rule that has saved cases, the app first asks Jev to score
the draft's conditions against each case and shows which pass: a wrong match
the draft no longer matches passes, and so does a right match it still
matches. You can then publish anyway or go back to the draft. If Jev cannot be
reached, the app says so and you can still publish. A rule with no saved
cases publishes straight away.

## Evaluation

```sh
sally evaluate FILE [--scale]
```

Runs a file of saved messages and replies, each with the rules expected to
match, through the engine with the real Jev, and reports right matches, wrong
matches and misses, with timing and tokens. `--scale` pads the rule set to
several hundred conditions and leads with the wrong-match rate. It needs an
API key and costs a little, so it runs only on request, never in CI. The file
format is in [docs/evaluation.md](docs/evaluation.md); a file built from real
messages stays outside the repository.

## Development

Requires Node 24 or later and pnpm. The command line runs its TypeScript
directly with Node's type stripping; only the web app is built (`pnpm build`).

```sh
pnpm install
pnpm check   # typecheck, lint and tests
```

The user-prompt-submit hook runs `sally hook message`; the stop hook runs
`sally hook reply`.

`pnpm dev` runs the web app with hot reload on sample data: a database in
`.dev/` and a stand-in matcher, so it needs no API key and never touches the
real database. `pnpm dev --fresh` starts the sample data over.

The web app is React with shadcn/ui, in `web/`. `pnpm dev:web` serves it with
hot reload and sends `/api` to a running `sally app`. Layouts and components
come from shadcn blocks through the `@shadcnblocks` registry set up in
`components.json`; adding one needs `SHADCNBLOCKS_API_KEY` in the environment
(for example in `.env.local`, which is never committed):

```sh
pnpm dlx shadcn@latest add @shadcnblocks/<block>
```

No guarantees. MIT licensed.
