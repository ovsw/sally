# Sally

Sally is a salience engine for Claude Code: on every turn it decides which of the user's written rules apply and hands Claude only those. This glossary fixes the words used for that.

## Language

### Rules

**Rule**:
One or more conditions plus one instruction, with a scope. A rule has no check type of its own: its conditions say which checks it takes part in. A rule lives only in Sally.
_Avoid_: Guideline, policy, memory

**Rules file**:
A file Claude Code loads into every session, such as CLAUDE.md, global or per project.
_Avoid_: Memory file, config, context file

**Always-rule**:
A rule that applies on every turn, and so stays in a rules file instead of Sally.
_Avoid_: Global rule, core rule, base rule

**Import**:
Turning the conditional rules in a rules file into drafts in Sally. Always-rules stay in the file.
_Avoid_: Migration (that is a change to the database between versions), move, conversion

**Passage**:
A piece of a rules file that says one thing, as an import found it. A passage is text in a file; a rule lives in Sally.
_Avoid_: Rule (for text still in a rules file), entry, item

**Condition**:
A short, concrete statement that is true or false of the text being checked. Each condition has two switches, Message and Reply, that say which checks use it; with both off, the condition is off and is not scored.
_Avoid_: Trigger, question, pattern

**Check type**:
Which of the two checks something belongs to: message or reply. A check has one check type; a condition is used in the check types its switches are on for.
_Avoid_: Rule type, kind

**Instruction**:
What Claude should do when a rule matches, given to Claude word for word.
_Avoid_: Reminder (Claude has not seen the rule before; Sally is the only place it lives), action, prompt

**Scope**:
Where a rule applies: all projects, or a named set of projects. Like a switch, it is separate from publishing: changing it takes effect at once.

**Project**:
The git repository a session runs in.
_Avoid_: Repo, workspace, folder

### Versions

**Version**:
One published, unchangeable state of a rule's text: its name, its instruction and the wording of its conditions. Switches and scope are not part of a version.

**Published version**:
A rule's latest published version: the one checks use while the rule is on. A rule can have a published version and a draft at the same time.
_Avoid_: Live version, active version, current version

**On / Off**:
Whether checks use a rule at all, set by its switch, and whether a check type uses a condition, set by that condition's Message and Reply switches. Switches are separate from publishing: they take effect at once and make no new version, and a rule switched off keeps its published version and its draft. Switching off a rule's last condition switches the rule off; it stays off until the user switches it on again, which needs at least one condition on.
_Avoid_: Enabled, disabled, live

**Switch change**:
A record of one change to a rule's switch, a condition's switch or a rule's scope, with its time. It is shown in a rule's history beside its versions, so a shift in how a rule matches can be traced to it.

**Draft**:
The one unpublished working copy of a rule, which has no effect until published.
_Avoid_: Pending version, unsaved changes

### Checks

**Check**:
One run of Sally over one text.
_Avoid_: Scan, evaluation, match run

**Message check**:
A check of the user's message, made before Claude starts work.

**Reply check**:
A check of Claude's final reply, made before the turn ends.

**Pasted text**:
Text the user pasted into a message, as their tool marks it. A message check leaves it out and puts a short note in its place, so rules are checked against what the user wrote.
_Avoid_: Attachment, document

**Score**:
The probability, from 0 to 1, that a condition holds for the text being checked.
_Avoid_: Confidence, match strength

**Cutoff**:
The score a condition must reach for its rule to match. Message checks and reply checks each have their own.
_Avoid_: Threshold

**Match**:
A rule with a condition for that check type that reached the cutoff in a check, and so was attached to the message or sent back on the reply.
_Avoid_: Firing, hit, trigger, activation

**Weak match**:
A match that scored just over the cutoff.
_Avoid_: Close match, borderline match

**Attached**:
How a match reaches Claude in a message check: its instruction goes with the user's message.

**Sent back**:
How a match reaches Claude in a reply check: Claude gets its instruction and one chance to revise the reply.

**Outcome**:
How a check ended: nothing (no rule matched), attached, sent back, skipped, or failed.
_Avoid_: Result, status

**Skipped**:
The outcome of a check where Sally chose not to ask Jev: a bare slash command, or a reply that was already sent back once.

**Failed**:
The outcome of a check that could not get scores, so Sally cannot say whether any rule matched.

**Sally's output**:
The set of rules Sally found salient in one check, handed to Claude together; when no rule matches there is no output.
_Avoid_: Reminder, bundle, attachment, injection

### Judging matches

**Flag**:
A verdict on one match, wrong or right, given by the user or by Claude. A match with no flag counts as right.
_Avoid_: Report, vote, rating

**Attention reason**:
Why a rule is on the Needs attention list, drawn from its pattern over many checks rather than from one match.
_Avoid_: Automatic flag, warning, alert

**Right match**:
A match of a rule that did apply.
_Avoid_: Correct match, true positive

**Wrong match**:
A match of a rule that did not apply.
_Avoid_: False positive, misfire

**Miss**:
A rule that applied and did not match.
_Avoid_: False negative

**Near miss**:
A score just under the cutoff.

**Saved case**:
A real message or reply kept with a rule, marked "should match" or "should not match".
_Avoid_: Test case, example, fixture
