# Slash commands and the message check

The spec asks the message check to judge a message that starts with a slash
command only on the text after the command name, and to skip the check when
nothing meaningful remains. This note records what Claude Code hands the
user-prompt-submit hook in that case, which the message check is built on.

## What Claude Code sends

Checked against Claude Code's hooks reference
(<https://code.claude.com/docs/en/hooks>, sections "UserPromptSubmit input"
and "UserPromptExpansion"), 2026-11-17:

- The `UserPromptSubmit` hook receives a `prompt` field holding the submitted
  text.
- When that text is a skill or custom command, such as `/deploy staging`, the
  hook receives the line **as the user typed it**, not the expanded skill
  content. Quoting the reference: "the hook receives that line as you typed
  it rather than the expanded skill content."
- Command names can carry a plugin prefix with a colon, for example
  `/my-plugin:example-skill arg1 arg2`.
- Claude Code has a separate `UserPromptExpansion` event, with
  `command_name` and `command_args` fields, for hooks that want the command
  itself. Sally does not use it: the message check needs only the typed text.
- Pasted text that collapsed to a `[Pasted text #N]` placeholder arrives
  expanded in place in `prompt`.
- `UserPromptSubmit` also runs on turns Claude Code starts on its own (a
  scheduled task or `/loop` iteration, a background subagent reporting back,
  a message from another session). These arrive as ordinary prompts.

## What the message check does with it

- A message is treated as starting with a slash command when its first
  characters are `/` and a command name (letters, digits, `-`, `_`, `.`,
  `:`), followed by whitespace or the end of the message. A message that
  starts with a path, such as `/home/me/notes.md is stale`, is not a command
  and is checked as it is.
- The command name is removed and only the rest is sent to Jev, so Jev never
  learns which skill or workflow was invoked.
- When fewer than three words remain (a bare command, or a command with only
  short arguments such as `/review-pr 123`), the check is skipped and recorded
  with the outcome `skipped`, and nothing is sent to Jev.
- The recorded text of a check is the text it judged: the message after the
  command name. A skipped check records the message as typed.
- The reply check is unaffected.
