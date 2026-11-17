# Sally

A salience engine for Claude Code.

You write rules as a condition and an instruction. On each turn Sally asks a
fast decision model (TypeSafe's Jev) which conditions hold, and hands Claude
only the instructions that apply: before it starts work on your message, and
again when it finishes its reply. When nothing applies, Sally stays silent.

Status: early. The message check works end to end; the rest of the spec is
tracked in this repository's issues.

## Where things live

- **API key**: the `TYPESAFE_API_KEY` environment variable, or the file
  `~/.config/sally/api_key` (readable only by you: `chmod 600`). Without a key
  Sally stays silent.
- **Database**: `~/.local/share/sally/sally.db` (SQLite). It holds your rules
  and every check, including the full text of your messages, so it never
  belongs in a repository.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` move these folders as usual;
`SALLY_CONFIG_DIR` and `SALLY_DATA_DIR` override them outright.

## Commands for agents

An agent can read your rules and prepare drafts; it cannot publish, switch off
or delete a rule. Those stay with you in the web app. Output is JSON.

```sh
sally rules list [--search TEXT] [--check-type message|reply] [--state live|draft]
sally rules show RULE            # id or exact name: live version beside draft
sally rules create --name NAME --check-type message|reply \
  --instruction TEXT --condition TEXT [--condition TEXT ...]
sally rules edit RULE [--name NAME] [--check-type message|reply] \
  [--instruction TEXT] [--condition TEXT ...]
```

`sally rules help` lists every option.

## Development

Requires Node 24 or later and pnpm. Sally runs its TypeScript directly with
Node's type stripping, so there is no build step.

```sh
pnpm install
pnpm check   # typecheck, lint and tests
```

The user-prompt-submit hook runs `sally hook message`.

No guarantees. MIT licensed.
