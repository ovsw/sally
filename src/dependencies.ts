// Sally's dependencies: the packages the web app is built and served with.
// The hooks and the install use only Node's own modules, so only the `app`
// command needs these.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Env } from "./paths.ts";

/** Sally's folder: the checkout this file is in. */
export const SALLY_DIR = join(import.meta.dirname, "..");

const normalize = (text: string) => text.replaceAll("\r\n", "\n");

/**
 * Whether the dependencies in `dir` are downloaded and in step with its
 * lockfile: pnpm keeps a copy of the lockfile it installed from in
 * node_modules, so the two match until the lockfile changes.
 */
export function dependenciesPresent(dir: string): boolean {
  try {
    const wanted = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    const installed = readFileSync(join(dir, "node_modules", ".pnpm", "lock.yaml"), "utf8");
    return normalize(wanted) === normalize(installed);
  } catch {
    return false;
  }
}

/** Whether `name` is a program on the PATH. */
function onPath(name: string, env: Env): boolean {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
  const folders = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  return folders.some((folder) => extensions.some((extension) => existsSync(join(folder, name + extension))));
}

/** The pnpm major version package.json's packageManager names, such as 11. */
function pnpmMajor(dir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown };
    const major = typeof manifest.packageManager === "string" ? /^pnpm@(\d+)/.exec(manifest.packageManager)?.[1] : undefined;
    if (major) return major;
  } catch {
    // Fall through to the default.
  }
  return "11";
}

/**
 * The command that downloads the dependencies, run in Sally's folder: pnpm
 * when it is on the PATH, otherwise pnpm fetched through npx for that one
 * command, at the major version package.json names.
 */
export function dependencyCommand(dir: string, env: Env): string {
  const pnpm = onPath("pnpm", env) ? "pnpm" : `npx --yes pnpm@${pnpmMajor(dir)}`;
  return `${pnpm} install --frozen-lockfile`;
}

/**
 * Runs the download command in `dir`, letting the package manager's output
 * through; returns whether it worked. Through a shell, because on Windows pnpm
 * and npx are .cmd files, which only a shell can start.
 */
export function runDownload(command: string, dir: string): boolean {
  const result = spawnSync(command, { cwd: dir, shell: true, stdio: ["ignore", "inherit", "inherit"] });
  return result.status === 0;
}

/** What to tell the user when the dependencies are missing: the exact command, and where to run it. */
export function dependencyAdvice(dir: string, env: Env): string {
  return `In Sally's folder, ${dir}, run: ${dependencyCommand(dir, env)}`;
}
