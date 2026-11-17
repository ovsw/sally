# Conditional rules live only in Sally

A rule that applies only in some situations is kept in Sally and nowhere else. It is removed from the rules files (CLAUDE.md, global or per project) once it is a rule in Sally. Only always-rules, which apply on every turn, stay in a rules file.

We considered keeping each conditional rule in the rules file as well, with Sally repeating it when it applied. We rejected that because the point of Sally is that Claude reads only the rules that apply to the turn: a rule that also sits in a rules file is still loaded into every session, so nothing is saved and the rules file keeps growing.

## Consequences

- What Sally hands Claude is an instruction, not a reminder: Claude has not seen the rule before.
- A rule has one home, so it cannot drift between two copies.
- A check that fails leaves the turn without the rules that would have matched. There is no copy in a rules file to fall back on, so how a failed check is handled matters more: Sally stops the turn on a failed check unless the user switches that off.
