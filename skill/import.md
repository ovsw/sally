# Import a rules file into Sally

You are running Sally's import. It turns the conditional rules in one of the
user's rules files into draft rules in Sally, lets the user review them in
Sally's web app, and then takes what they published out of the rules file.
Always-rules stay in the file.

Sally's command line is run by its absolute path, so it works from any folder:
in the commands below, `node "<cli>"` stands for the command the installed
skill gave you (`node "<path to Sally's checkout>/src/cli.ts"`). Its `import`
and `rules` commands print JSON. The checkout is the folder above the one
holding this file; `docs/writing-rules.md` in it is the guidance on writing
rules.

Hold to these throughout:

- **One rules file per import.** Files it pulls in with `@path` belong to its
  import.
- **The user publishes.** The command line creates drafts only. Publishing,
  keeping and skipping happen in the web app, by the user.
- **The rules file changes only in step 8**, and only after a backup made with
  `node "<cli>" import backup` and the user's yes for that file. Only rules
  that are live leave the file.

If the user comes back to an import already under way ("I'm done reviewing",
"remove what I published"), run `node "<cli>" import list`, take the newest
import whose `removedAt` is null (ask if several), and go to step 7. Its
removal may have happened in part already, when the user took out what was
published before finishing the review.

## 1. Find the rules files

Work out the project folder: the git top level of the current folder
(`git rev-parse --show-toplevel`), or the current folder outside git. The
user's Claude Code folder is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.

Collect every file below that exists and holds text:

- **Global**: `<Claude Code folder>/CLAUDE.md`, and each `.md` file in
  `<Claude Code folder>/rules/`, searched recursively.
- **Project**: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and each
  `.md` file in `.claude/rules/` (recursively), in the project folder.
- **Below the project**: the same four in every folder under the project
  folder.

Find the project's files with your file search tool, patterns
`**/CLAUDE.md`, `**/CLAUDE.local.md` and `**/.claude/rules/**/*.md` from the
project folder, and drop any under `node_modules`, `.git`, `vendor`, `dist`,
`build` or another dependency or build folder. Search the files themselves,
not `git ls-files`: `CLAUDE.local.md` is usually ignored by git and must still
be found.

Leave out:

- a rules folder file whose frontmatter has `paths` (it already loads only
  when relevant);
- `AGENTS.md` anywhere (other tools read it);
- rules files in folders above the project, other than the global ones.

For each project file, check whether git tracks it:
`git ls-files --error-unmatch <file>` succeeds when it does. Mark those
**shared**.

Show the user a numbered list: each file's path, global or project, and
"shared" where it applies. Ask which one file to import. **Stop and wait for
the answer.**

## 2. Read the file

Read the chosen file in full. Then read each file it pulls in: a line with
`@path` (not inside a code span or code block, and not an email address)
names one. A relative path is relative to the file holding it; `\ ` is a space
in the path. Pulled-in files can pull in others, up to four steps deep.

Leave Sally's own line out of everything that follows: the line that begins
"Sally, a hook, attaches some of my written rules". It is an always-rule
install wrote, and it stays.

If the file is shared, tell the user now: "This rules file is tracked in git,
so removing rules from it affects everyone who reads it. I'll import it
without removing anything unless you tell me you are the only one using this
project." Carry on; you ask about removal in step 8.

## 3. Read the guidance and the rules already in Sally

- Read `docs/writing-rules.md` in Sally's checkout, all of it. Every verdict,
  condition and instruction you write follows it.
- Run `node "<cli>" rules list` and keep the rules' names, instructions and
  conditions in mind for step 4.

## 4. Split it into passages and propose

A **passage** is a piece of the rules file that says one thing. Split the
file, and each file it pulls in, into passages:

- A passage's text is copied **exactly** from the file: whole, consecutive
  lines, unchanged, so it can be found again in step 8. Headings, blank lines
  and `@path` lines are not passages.
- One thing per passage: a bullet list where each bullet is its own
  instruction is several passages; a paragraph that explains one instruction
  is one.
- Keep file order: the chosen file's passages, with a pulled-in file's
  passages where its `@path` line stands.

For each passage, decide:

- **verdict**: `becomes_rule`, `always_rule` or `too_vague`, by
  "The three verdicts of an import" in the guide.
- **reason**: one or two sentences written as a **lesson** the user can apply
  to the next passage they write, not a description of this one. For example:
  "Advice on how to talk applies on every turn, so it belongs in the rules file
  where Claude always sees it."
- **rules**, for `becomes_rule` only: one rule per situation, following the
  guide (conditions describe a request or a failure in the message or the
  reply; choose the message check or the reply check; write the instruction
  for the moment it arrives). A passage that bundles several situations gets
  several rules. Each rule has a short `name`, an `instruction`, its
  `conditions`, and `checkType` (`message` or `reply`). Never combine passages
  into one rule.
- **similarRule**, when the passage looks like a rule already in Sally: a short
  note naming it, such as `Looks like the rule "Run the tests" (id 12), which
  already asks for this.` Leave it out otherwise.

Done when every line of the file and its pulled-in files, other than headings,
blank lines, `@path` lines and Sally's line, sits in exactly one passage.

## 5. Record the import

1. Run `node "<cli>" import start <absolute path of the chosen file>`. Keep
   the `id`.
2. Write the passages as a JSON list to a file in the system's temporary
   folder (never in the project):
   `[{ "text", "verdict", "reason", "similarRule"?, "rules"?: [{ "name",
   "checkType", "instruction", "conditions": [...] }] }]`
3. Run `node "<cli>" import add <id> --file <that file>`. It adds all the
   passages or none; if it refuses, fix what the message names and run it
   again.
4. Run `node "<cli>" import show <id>` and check that `passageCount` is the
   number of passages you wrote. Delete the temporary file.

## 6. Send the user to review

Make sure the web app is running: `curl -s http://localhost:${SALLY_PORT:-4517}/api/imports`
answers when it is. If it does not, start `node "<cli>" app` in the
background and use the address it prints (another port when `SALLY_PORT` is
set).

Tell the user, in a few lines:

- how many passages there are and how many become rules;
- to open `<address>/imports/<id>`, where they see one passage at a time and
  publish, keep as a draft, or skip each proposed rule, and can overrule a
  verdict either way;
- to come back here and say when they are done, and that nothing leaves the
  rules file until then.

**Stop and wait.** End your turn here.

## 7. Read the user's decisions

Run `node "<cli>" import show <id>`. In its output:

- `pendingCount`: passages the user has not finished (a passage that stays
  counts until the user has looked at it). If it is above zero, say how many,
  and ask whether to take out what is published so far or to wait. **Stop and
  wait for the answer.**
- `removeAll`: positions of passages whose rules are all live and switched
  on. The whole passage leaves the file.
- `removePart`: positions of passages where only some rules are live and on.
  Only the part those rules cover leaves; the rest stays.
- Each passage's `rules` list each rule's `decision`, `live` and `on`, with
  the instruction and conditions to tell which part of the text a rule
  covers. A rule that is live but switched off is not in effect, so its part
  of the passage stays.

The user may have changed a rule's instruction or conditions in review.
Compare each rule that is live and on with its passage's text: a part of the
passage that no such rule still asks for stays in the file, even for a
passage in `removeAll`. When in doubt, leave the text.

If both lists are empty, tell the user nothing was published, so the rules
file stays as it is. If `pendingCount` is zero, run
`node "<cli>" import removed <id>`. Go to step 9.

## 8. Remove what was published

1. Read the rules file, and any pulled-in file holding a passage to remove,
   **as they are now**. Find each passage's text. If a passage's text is no
   longer there exactly, leave it, and tell the user it changed since the
   import began or was taken out in an earlier round. If it is there more
   than once, in one file or across the rules file and its pulled-in files,
   you cannot tell which copy the import took: leave every copy and tell the
   user, so they can take out the right one themselves.
2. Work out the lines to remove:
   - `removeAll`: the passage's lines and one blank line beside them, plus a
     heading left with nothing under it. When a pulled-in file is left with
     nothing in it, also remove its `@path` line; leave the empty file.
   - `removePart`: only the sentences or lines that the live rules cover. Show
     the passage before and after; what remains must still read as a complete
     instruction.
3. Check each file you would edit on its own, the rules file and every
   pulled-in file, even when you came back to the import at step 7:
   `git ls-files --error-unmatch <file>`, run from that file's folder,
   succeeds when git tracks it. A file git ignores says nothing about the
   files it pulls in. For each tracked file, unless the user has said they are
   the only one using that file, ask: "<file> is tracked in git. Remove these
   lines from it anyway? Only say yes if you are the only one using this
   file." Without that yes, leave that file unchanged. If no file is left to
   edit, run `node "<cli>" import removed <id>` and go to step 9.
4. Show the user the exact lines, grouped by file, with their line numbers.
   Ask for one yes for this rules file, and say they can hold back any lines
   by number. **Stop and wait for the answer.**
5. On a yes, check again before touching anything, since the user may have
   changed things while you waited: run `node "<cli>" import show <id>` and
   read each file again. If a passage you would remove is no longer in
   `removeAll` or `removePart` with the same rules live and on, or the agreed
   lines no longer stand in the file exactly as you showed them, edit
   nothing: work out the lines again from step 1, show them and ask again.
6. Run `node "<cli>" import backup <file>` for each file you will edit and
   tell the user each backup's path.
7. Edit the file, removing only the agreed lines.
8. Check: compare each backup with its file (`diff <backup> <file>`). Only the
   agreed lines are gone and nothing else changed.
9. If `pendingCount` was zero, run `node "<cli>" import removed <id>`. If
   passages were still pending, do not: the import stays open, so the user
   can finish reviewing and come back to remove the rest, and passages
   removed now are simply no longer found then.

## 9. Offer the next rules file

Tell the user what was removed and where the backup is. Then show the list
from step 1 again without the file just done, and ask whether to import
another. On a pick, go to step 2.
