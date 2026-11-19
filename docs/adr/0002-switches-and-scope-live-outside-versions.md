# Check type belongs to the condition, and switches and scope live outside versions

One instruction often has to apply both to the user's message and to Claude's reply, with slightly different conditions for each. While a rule had a single check type, that meant two rules with the same instruction. So a rule no longer has a check type: each condition has a Message switch and a Reply switch, and a rule takes part in a check when one of its conditions is on for that check type. A version holds only a rule's text (name, instruction, the wording of its conditions); the rule's switch, the condition switches and the scope take effect at once and make no new version.

This reverses an earlier choice, where check type and scope were part of a version and changed only on publishing.

## Considered options

- **A rule with both check types and one shared set of conditions.** Rejected: the conditions for a message and for a reply usually differ.
- **A shared instruction that two rules point at.** Rejected: one more thing to manage, and still two rules to name, switch and judge.
- **Switches and scope kept in the version.** Rejected: switching a condition off and on to try something would add two versions each time, burying the text changes that versions exist to show.

## Consequences

- A condition outlives its versions: it keeps its switches while its wording changes from one version to the next. A condition added in a draft starts counting when the draft is published.
- A rule's match rate can change with no new version. Every switch change and scope change is therefore recorded with its time and shown in the rule's history beside its versions.
- Switching off a rule's last condition switches the rule off. The rule does not come back on by itself, and cannot be switched on while none of its conditions is on.
- A rule attached on the message is still checked on the reply: attaching tells Claude the rule, the reply check catches a reply that ignored it.
