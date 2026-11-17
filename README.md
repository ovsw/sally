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
line to `~/.claude/CLAUDE.md` saying that Sally's reminders are your rules and
carry the same authority as that file. Running it again changes nothing.
Uninstall removes exactly those entries. Both leave everything else in the two
files as it was, and both follow `CLAUDE_CONFIG_DIR` when it is set.

## Where things live

- **API key**: the `TYPESAFE_API_KEY` environment variable, or the file
  `~/.config/sally/api_key` (readable only by you: `chmod 600`). Without a key
  Sally stays silent.
- **Database**: `~/.local/share/sally/sally.db` (SQLite). It holds your rules
  and every check, including the full text of your messages, so it never
  belongs in a repository.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` move these folders as usual;
`SALLY_CONFIG_DIR` and `SALLY_DATA_DIR` override them outright.

## Development

Requires Node 24 or later and pnpm. Sally runs its TypeScript directly with
Node's type stripping, so there is no build step.

```sh
pnpm install
pnpm check   # typecheck, lint and tests
```

The user-prompt-submit hook runs `sally hook message`; the stop hook runs
`sally hook reply`.

No guarantees. MIT licensed.
