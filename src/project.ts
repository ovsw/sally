import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/** How long a git call may take before the folder path is used instead. */
const GIT_TIMEOUT_MS = 1000;

function git(cwd: string, args: string[]): { ok: true; out: string } | { ok: false; status: number | null } {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return { ok: false, status: typeof status === "number" ? status : null };
  }
}

/**
 * A remote's URL as owner and name, lowercased: `git@github.com:Owner/Repo.git`,
 * `https://user@github.com/owner/repo` and `ssh://git@github.com/owner/repo.git/`
 * all become `owner/repo`. The host and any credentials are dropped.
 */
export function normalizeRemote(url: string): string | undefined {
  let path = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (scheme) {
    // scheme://[user@]host[:port]/path
    path = path.slice(scheme[0].length);
    const slash = path.indexOf("/");
    path = slash === -1 ? "" : path.slice(slash + 1);
  } else {
    // scp-like: [user@]host:path. A plain local path has no colon before its first slash.
    const colon = path.indexOf(":");
    const slash = path.indexOf("/");
    if (colon !== -1 && (slash === -1 || colon < slash)) path = path.slice(colon + 1);
  }
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  segments[segments.length - 1] = segments[segments.length - 1]!.replace(/\.git$/i, "");
  const key = segments.slice(-2).filter((s) => s.length > 0).join("/").toLowerCase();
  return key || undefined;
}

/**
 * The project a session's folder belongs to. In a git repository it is the
 * repository's remote (origin, or else the first remote) as owner and name,
 * so every worktree and subfolder of one repository is the same project. A
 * repository with no remote is its main folder; a folder outside any
 * repository is its own path. Never throws.
 */
export function resolveProject(cwd: string): string {
  const folder = resolve(cwd);
  // --local reads only the repository's own config (shared by its worktrees)
  // and refuses outside a repository.
  const remotes = git(folder, ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"]);
  if (remotes.ok) {
    const urls = new Map<string, string>();
    for (const line of remotes.out.split("\n")) {
      const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
      if (match && !urls.has(match[1]!)) urls.set(match[1]!, match[2]!);
    }
    const url = urls.get("origin") ?? urls.values().next().value;
    const key = url === undefined ? undefined : normalizeRemote(url);
    if (key) return key;
  }
  // Exit status 1 from git config means a repository with no remote; anything
  // else (not a repository, no git, a timeout) falls back to the folder.
  if (!remotes.ok && remotes.status !== 1) return folder;
  const common = git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return folder;
  const dir = common.out.trim();
  return dir.endsWith("/.git") ? dirname(dir) : dir || folder;
}
