# Issue tracker: GitHub

Issues, the spec and its tickets live as GitHub issues in `ovsw/sally`. Use
the `gh` CLI.

- Read an issue: `gh issue view <number> --comments`
- Create: `gh issue create --title "..." --body "..."`
- Comment: `gh issue comment <number> --body "..."`
- Labels: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`
- Tickets are sub-issues of the spec (`gh api repos/ovsw/sally/issues/<parent>/sub_issues`).
- Blocking uses GitHub's native issue dependencies:
  `gh api --method POST repos/ovsw/sally/issues/<child>/dependencies/blocked_by -F issue_id=<blocker database id>`.
  A ticket is unblocked when every blocker is closed.
- "Publish to the issue tracker" means create a GitHub issue.
