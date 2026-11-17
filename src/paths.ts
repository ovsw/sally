import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

function home(env: Env): string {
  return env.HOME || homedir();
}

/** The user's data folder for Sally, which holds the database. */
export function dataDir(env: Env): string {
  if (env.SALLY_DATA_DIR) return env.SALLY_DATA_DIR;
  const base = env.XDG_DATA_HOME || join(home(env), ".local", "share");
  return join(base, "sally");
}

/** The user's config folder for Sally, which may hold the API key file. */
export function configDir(env: Env): string {
  if (env.SALLY_CONFIG_DIR) return env.SALLY_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(home(env), ".config");
  return join(base, "sally");
}

export function databasePath(env: Env): string {
  return join(dataDir(env), "sally.db");
}

/**
 * The Jev API key: from TYPESAFE_API_KEY, otherwise from the private file
 * `api_key` in the config folder. Undefined when neither holds one.
 */
export function readApiKey(env: Env): string | undefined {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(join(configDir(env), "api_key"), "utf8").trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}
