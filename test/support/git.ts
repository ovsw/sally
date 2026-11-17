import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Git run in a throwaway folder, ignoring the user's own git config. */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/**
 * Creates a git repository at `path` with one commit and, when given, these
 * remotes (name to URL). Returns its path.
 */
export function gitRepo(path: string, remotes: Record<string, string> = {}): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "start");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
}

/** Sets a value in the repository's own config. */
export function gitConfig(repo: string, key: string, value: string): void {
  git(repo, "config", "--local", key, value);
}

/** Adds a worktree of `repo` at `path`, on a new branch. Returns its path. */
export function gitWorktree(repo: string, path: string, branch = "other"): string {
  git(repo, "worktree", "add", "--quiet", "-b", branch, path);
  return path;
}

/** Creates a plain subfolder of `parent`, outside any repository unless the parent is one. */
export function folder(parent: string, ...names: string[]): string {
  const path = join(parent, ...names);
  mkdirSync(path, { recursive: true });
  return path;
}
