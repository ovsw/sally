<!--
The one source of guidance on writing rules for Sally. The Guide page in the
web app shows this file from its first "##" heading down, and the import skill
reads all of it. Change the advice here; nothing else repeats it.
-->

# Writing rules for Sally

This is how to turn what you want from Claude into rules that match well. It
has two readers: a person writing a rule in Sally's web app, and an agent
turning the text of a rules file into rules during an import. Both follow the
same advice. The words used here are defined in `GLOSSARY.md`.

## Always-rules and conditional rules

A rule in Sally has one or more conditions and one instruction. On each check,
Sally asks Jev how likely each condition is to hold of the text being checked,
and gives Claude the instructions of the rules that match. A rule that does not
match costs nothing: Claude never sees it.

So Sally is for **conditional rules**, which apply only in some situations. A
rule that applies on every turn is an **always-rule**. It stays in your rules
file, where Claude reads it in every session.

| Text in a rules file | What it is | Why |
| --- | --- | --- |
| "Write in British English." | Always-rule | Every reply has spelling. No turn is free of it. |
| "Keep replies to a few lines unless I ask for more." | Always-rule | It applies to every reply. |
| "This project uses pnpm, never npm." | Always-rule | It matters in the middle of the work, when Claude runs a command. Sally does not see that moment. |
| "When I ask for a database migration, make it reversible." | Conditional rule | It applies only when the message asks for a migration. |
| "When you report a finished visual change, give me the local link to the page." | Conditional rule | It applies only to replies that report a visual change. |

### How to tell an always-rule

Keep a passage in the rules file as an always-rule when any of these is true:

1. **It applies to every turn, or nearly every turn.** Tone, language, length,
   how to address you.
2. **The situation shows up only in the middle of Claude's work.** Sally checks
   two texts: your message, before Claude starts, and Claude's final reply,
   before the turn ends. It does not see the commands Claude runs or the files
   it edits. If you cannot write a condition about the message or the final
   reply that is true when the rule applies, the rule cannot match in Sally.
3. **It is background Claude needs while it works.** What the project is, where
   things live, which tools it uses.

Everything else is a candidate for Sally. Moving a rule into Sally means it
reaches Claude only on the turns where it matches. When a message check fails,
Sally stops the message rather than let it go on without its rules, unless you
switch that off with the `stop-on-failure` setting. A reply whose check failed
stands, with a warning that it was not checked.

### The three verdicts of an import

When an import judges a passage of a rules file, it gives one of three
verdicts. They use the tests above.

- **Becomes a rule.** The passage applies in a situation you can describe in a
  condition. It becomes one or more rules, created as drafts.
- **Stays as an always-rule.** The passage applies on every turn, applies in the
  middle of the work, or is background. It stays in the rules file.
- **Stays, too vague to match on.** The passage names no situation that a
  condition could describe. It stays in the rules file until someone rewrites
  it. See [When a passage is too vague to match on](#when-a-passage-is-too-vague-to-match-on).

## Writing a condition that matches well

### How a condition is judged

Knowing what Jev sees explains most of the advice below.

- **Jev sees only the condition and the text being checked.** It never sees the
  instruction, the rule's name, earlier messages in the session, the project, or
  what Claude did during the turn.
- **The text is one message or one reply.** In a message check it is your
  message as you sent it. A message that starts with a slash command is judged
  on the words after the command name, and not checked at all when fewer than
  three words follow it: `/review migration` matches no rule. In a reply check it is Claude's final
  reply: not its reasoning, not its tool output.
- **Each condition is its own yes-or-no question.** Jev answers it with a score
  from 0 to 1: how likely the condition is to hold of the text. Conditions are
  scored one by one, so a rule's other conditions do not help or hurt.
- **A rule matches when any one of its conditions reaches the cutoff.** The
  cutoff is 0.6 unless it was changed in Settings.
- Email addresses are replaced with `[email]` before anything is sent. Text
  pasted into a message in T3 Code is left out, with a note in its place. A
  very long text keeps its start and end and loses its middle.

So a condition has to be true or false of that one text, read on its own.

### What a good condition looks like

1. **A statement, not a question or an order.** "The user's message asks for a
   database migration." Not "Does the user want a migration?" and not "Write a
   reversible migration."
2. **It names the text it is about.** Start with "The user's message ..." in a
   message check, and "This reply ..." in a reply check.
3. **One situation.** If it lists alternatives ("or", "and also", a list of
   ways the situation shows up), each alternative is its own condition: give
   each its own line in the same rule. Things that must all hold together stay
   in one condition, as in "This reply reports a finished visual change and
   gives no local link to the page."
4. **Concrete.** It describes something you could point to in the text. "Asks
   Claude to rename a public function" can be pointed to; "is about code
   quality" cannot.
5. **About what the message asks or what the reply does, not the subject it
   mentions.** A message that only talks about migrations is not a request to
   write one. Sally's first prototype matched a rule to a message that merely
   discussed the rule's subject; conditions that name the request avoid this.
   - Message check. Subject: "The message is about database migrations", which
     also matches "how do migrations work here?". Request: "The user asks
     Claude to write or change a database migration."
   - Reply check. Subject: "The reply mentions tests", which matches any reply
     that brings them up. Failure: "The reply says the work is done and does
     not say the tests were run."
6. **Short.** One sentence. If it needs a second sentence, it is probably two
   conditions.
7. **Decidable from this text alone.** Avoid words that point outside the text:
   "again", "as before", "in this project", "the usual way". Jev cannot see
   what they refer to.
8. **No instruction inside it.** How Claude should respond belongs in the
   instruction. Jev never sees the instruction, and how-to text in a condition
   blurs the question of whether the rule applies.

A quick test: write one message (or reply) the condition is plainly true of,
and one that is close but should not match. If you cannot write the second
one, the condition is too broad.

### Before and after: a vague passage

A passage in a rules file:

> Be careful with database stuff. Migrations should be reversible.

| | Condition | Instruction |
| --- | --- | --- |
| Before | "Database work." | "Be careful with database stuff. Migrations should be reversible." |
| After | "The user's message asks Claude to write or change a database migration." | "Make the migration reversible: write the down step, and check that it undoes the up step." |

"Database work" is a topic, not a statement. It would match any message that
mentions a database, including a question about one. The new condition names
the request, so a message that only discusses the database scores low.

### One situation per condition

A rule can have several conditions. Each covers one way the situation shows up,
and the rule matches when any one of them reaches the cutoff.

Before, one condition doing three jobs:

- "The user wants a short answer, or complained about long replies, or wrote tl;dr."

After, one rule named "Short answers" with three conditions:

- "The user's message asks for a short answer."
- "The user's message complains that a previous reply was too long."
- "The user's message asks for a summary in one line."

Instruction: "Answer in a few lines. Leave out background unless I ask for it."

Each condition is scored on its own, so you can see which one matched and fix
a bad one without touching the others.

### Splitting a passage that bundles situations

A passage often packs several rules into one sentence:

> When writing tests, don't mock the database. When you open a PR, link the
> issue. Before a release, update the changelog.

This becomes three rules, each with its own condition and instruction:

| Rule | Check | Condition | Instruction |
| --- | --- | --- | --- |
| Tests use a real database | Message | "The user's message asks Claude to write or change tests." | "Do not mock the database in tests. Use a temporary database." |
| Link the issue in a PR | Reply | "This reply says a pull request was opened and does not link the issue it addresses." | "Edit the pull request so its description links the issue it addresses, then say so." |
| Changelog before a release | Message | "The user's message asks Claude to prepare or publish a release." | "Update the changelog before the release." |

One passage can produce several rules. Several passages are never merged into
one rule.

### Message check or reply check

- **Message check** when the situation is visible in what you ask, before
  Claude starts. The instruction is attached to your message, so Claude can do
  the right thing from the start.
- **Reply check** when the situation is visible only in Claude's handover. The
  condition describes the failure itself. When it matches, Claude gets the
  instruction and one chance to revise the reply.

A reply-check condition describes what is wrong with the reply, not only what
the reply is about:

| | Condition |
| --- | --- |
| Too broad | "This reply reports a finished visual change." |
| Good | "This reply reports a finished visual change and gives no local link to the page." |

The broad version also matches replies that already give the link, so Claude
is sent back for nothing. That is a wrong match.

A reply-check condition also has to be visible in the reply's words. Jev cannot
see whether Claude ran the tests, only what the reply says:

| | Condition |
| --- | --- |
| Not visible | "Claude did not run the tests." |
| Visible | "This reply says code was changed and does not say whether the tests were run." |

### When a passage is too vague to match on

Some passages name no situation at all:

> Be thoughtful. Write good code. Use common sense.

There is nothing for a condition to describe. Either the passage applies to
every turn, which makes it an always-rule if it is worth keeping, or it applies
to situations it does not name. Use the quick test above: if you cannot write a
message the condition is false of, the passage is too vague to match on.

Leave it in the rules file. If you know the situation you meant, write that
situation as its own rule instead. "Write good code" might really mean "When I
ask for a new function, add a test for it", which is a rule:

- Condition: "The user's message asks Claude to add a new function."
- Instruction: "Add a test for the new function in the same change."

### Writing the instruction

- **It stands alone.** Claude receives it word for word, with the rule's name,
  and has not seen it before: the rule lives only in Sally. Say what to do. Do
  not refer to "what we discussed" or "the usual way".
- **It adds something.** A rule is worth having only when its instruction is not
  already implied by the text it matches. The condition "The user's message
  asks for tests" with the instruction "Write tests" adds nothing.
- **It is about this situation only.** One or a few sentences on what to do now.
- **The name is short and says what the rule is about.** Claude sees it, and
  uses it to report a rule that did not apply.

A rule also has a scope: all projects, or named projects. A rule about one
project's code belongs to that project.

### Checklist

For each rule:

- It is a conditional rule, not an always-rule.
- Its check type fits: message check when the situation is in what you ask,
  reply check when it is in Claude's handover.
- Each condition is one sentence, starts with "The user's message" or
  "This reply", and describes one situation.
- Each condition describes a request or a failure, not a subject.
- Each condition can be judged from that one text alone.
- You can write a close example that should not match.
- The instruction stands alone, says what to do, and is not implied by the
  condition.
