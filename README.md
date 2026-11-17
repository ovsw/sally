# Sally

A salience engine for Claude Code.

You write rules as a condition and an instruction. On each turn Sally asks a
fast decision model (TypeSafe's Jev) which conditions hold, and hands Claude
only the instructions that apply: before it starts work on your message, and
again when it finishes its reply. When nothing applies, Sally stays silent.

Status: not built yet. The spec is tracked in this repository's issues.

No guarantees. MIT licensed.
