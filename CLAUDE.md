# Sally

A salience engine for Claude Code. The spec is issue #1 in `ovsw/sally`; its
sub-issues are the tickets. Read the spec's Vocabulary and Implementation
Decisions before writing code, and use its words (rule, condition,
instruction, check, match, cutoff, draft, live version).

- This repository is public. Never commit secrets, API keys, the database,
  real user messages, client names, or personal contact details. Evaluation
  data built from real messages stays outside the repository.
- TypeScript throughout, pnpm, one package. The hook path must start fast and
  must not load web app code.
- Jev is reached only through the matcher. Tests use the stand-in matcher and
  never call the real API. Only the evaluation command calls Jev, and it is
  not part of CI.
- Tests check behaviour from outside: hook input in, hook output and database
  state out; the rules service through its interface. Do not test internals.
- Tests and commands must never touch the real Claude Code settings, the real
  global rules file, or the real database. Use temporary files.

## Web app

Built with React and shadcn/ui. Take layout and components from shadcn blocks
through the `@shadcnblocks` registry (`https://www.shadcnblocks.com/r/{name}`,
header `Authorization: Bearer ${SHADCNBLOCKS_API_KEY}`), using the shadcn MCP
or CLI. The key is in `.env.local` in the main checkout (git-ignored; in a
worktree, read it from the main checkout). A block's theme and base styles
come with it. Before calling a screen done, compare a screenshot of it with
its reference block. Never open a window on the desktop: screenshots are
headless only.

## Checks

While you work, run typecheck, lint and the tests for what changed. Run the
full suite once before opening a pull request.

## Commits

Conventional Commits: `type(scope): summary`, imperative and lowercase. Say
why in the body.

## Agent skills

### Issue tracker

Issues, the spec and its tickets live as GitHub issues in `ovsw/sally`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
