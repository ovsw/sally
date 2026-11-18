# Evaluation against the real Jev

The `evaluate` command measures how well the engine matches on real text. It
takes a file of saved messages and replies, each with the rules expected to
match, runs every one through the engine with the real Jev matcher, and reports
right matches, wrong matches and misses, with timing and tokens.

It calls Jev, so it needs an API key (`TYPESAFE_API_KEY` or
`~/.config/sally/api_key`) and costs a little. It runs only when you ask for
it. It is not part of `pnpm check` or CI, and the tests run it only with a
stand-in matcher.

Run it in Sally's folder:

```sh
node src/cli.ts evaluate ~/sally-eval/evaluation.json           # or: pnpm evaluate FILE
node src/cli.ts evaluate ~/sally-eval/evaluation.json --scale   # pad to 400 conditions per check type
node src/cli.ts evaluate FILE --scale --conditions 800          # pad to 800 (needs your own padding)
node src/cli.ts evaluate FILE --cutoff 0.7 --time-limit 5000
node src/cli.ts evaluate FILE --json                            # every case, with scores, as JSON
```

The rules come from the file, not from your database. The command builds them
in a temporary database, runs the checks there and deletes it afterwards, so
your rules, your checks and the analytics in the app are left untouched.

## Keep real data out of the repository

An evaluation file built from real messages holds private text. Keep it
outside this repository, for example in `~/sally-eval/`. The only evaluation
file in the repository is the made-up example below.

## The file

One JSON object with `rules` and `cases`, and optionally `padding`.

```json
{
  "rules": [
    {
      "name": "Local link for visual changes",
      "check": "reply",
      "conditions": [
        "This reply reports a finished visual change and gives no local link to the page."
      ],
      "instruction": "Give the localhost link to the changed page."
    },
    {
      "name": "Brief replies",
      "check": "message",
      "conditions": [
        "The user's message asks for a short answer.",
        "The user's message complains that a previous reply was too long."
      ]
    }
  ],
  "cases": [
    {
      "label": "short answer",
      "check": "message",
      "text": "Just tell me in one line: does the build pass?",
      "expected": ["Brief replies"]
    },
    {
      "label": "unrelated question",
      "check": "message",
      "text": "What does the retry option in the fetch helper do?",
      "expected": []
    },
    {
      "label": "button colour done",
      "check": "reply",
      "text": "Done: the button is now blue and the spacing under the header is fixed.",
      "expected": ["Local link for visual changes"]
    }
  ]
}
```

A complete version is in [`evaluation-example.json`](evaluation-example.json).

**Rules.** Each rule has a `name` (unique), a `check` (`"message"` or
`"reply"`) and a non-empty list of `conditions`, written as they would be in
Sally. `instruction` is optional: Jev never sees it, so it does not change the
result. Every rule applies to all projects.

**Cases.** Each case is one saved message or reply:

- `check`: `"message"` for a message you sent, `"reply"` for Claude's final
  reply.
- `text`: the full text, as Sally would receive it. A message that starts with
  a slash command is judged as the engine judges it: on the text after the
  command name, or skipped when little follows.
- `expected`: the names of the rules that should match, `[]` when none should.
  Each must be a rule of the same check type in the file.
- `label`: optional, shown in the report. Cases without one are numbered.

**Padding** (optional, for the scale run): `{ "message": [...], "reply": [...] }`,
lists of conditions that should never hold of your cases. Without it the scale
run uses Sally's built-in padding: made-up conditions about everyday subjects
far from software work (gardening, travel, cooking, sport), up to 500 per check
type.

## What the report says

- **Right match**: an expected rule matched.
- **Wrong match**: a rule matched that the case did not expect. This is the
  failure that matters most, since it teaches Claude to discount the rules Sally attaches.
- **Miss**: an expected rule did not match. The report gives its best score, so
  a near miss is easy to spot.
- **Wrong-match rate**: the share of checks that ran (neither failed nor
  skipped) with at least one wrong match.
- **Failed checks** (timeout, Jev error) are listed with their error and left
  out of the counts above, so a slow Jev does not look like a miss. A check
  counts as failed only after its second try also failed.
- **Time per check**: the engine's own duration per check, Jev's round trip
  included. **Input tokens**: what Jev reported, in all and for the largest
  check. Both cover only the checks that ran: a skipped check never asks Jev.

The engine settings are Sally's defaults (cutoff 0.6, time limit 10 seconds)
unless `--cutoff` or `--time-limit` say otherwise.

## The scale run

`--scale` pads the rules of each check type that has cases up to 400
conditions (`--conditions N` sets another number) with one-condition padding
rules, then runs every case. Any match of a padding rule is a wrong match.
Its headline number, printed first, is the wrong-match rate: how often a large
rule set makes an unrelated rule match.
