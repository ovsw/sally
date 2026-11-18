import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createJevMatcher } from "../jev.ts";
import { databasePath, type Env, readApiKey } from "../paths.ts";
import { createImportService } from "../import.ts";
import { createRulesService } from "../rules.ts";
import { openStore } from "../store.ts";
import { createAppServer, listen } from "./server.ts";

export const DEFAULT_PORT = 4517;

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function newestChange(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newestChange(join(path, name))));
}

function modifiedSince(path: string, time: number): boolean {
  try {
    return newestChange(path) > time;
  } catch {
    return false;
  }
}

/** Builds the web app into dist/web when the build is missing or older than its sources. */
async function ensureBuilt(log: (line: string) => void): Promise<string> {
  const webDir = join(packageRoot, "dist", "web");
  let builtAt = 0;
  try {
    builtAt = statSync(join(webDir, "index.html")).mtimeMs;
  } catch {
    // Not built yet.
  }
  const sources = ["web", "vite.config.ts", "components.json", "package.json"].map((p) => join(packageRoot, p));
  if (builtAt === 0 || sources.some((source) => modifiedSince(source, builtAt))) {
    log("Building the web app...");
    const { build } = await import("vite");
    await build({ configFile: join(packageRoot, "vite.config.ts"), logLevel: "warn" });
  }
  return webDir;
}

function parsePort(args: string[], env: Env): number {
  const flag = args.indexOf("--port");
  const raw = flag >= 0 ? args[flag + 1] : env.SALLY_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Not a port: ${raw}`);
  return port;
}

/**
 * `sally app [--port N]`: serves the web app and its API on this machine only
 * and prints the address. SALLY_WEB_DIR serves an already built app from
 * elsewhere instead of building dist/web.
 */
export async function runApp(args: string[], env: Env): Promise<void> {
  const port = parsePort(args, env);
  const log = (line: string) => process.stdout.write(line + "\n");
  const webDir = env.SALLY_WEB_DIR || (await ensureBuilt(log));
  const store = openStore(databasePath(env));
  // Jev re-scores a draft against its saved cases before publishing.
  const apiKey = readApiKey(env);
  const matcher = apiKey ? createJevMatcher({ apiKey }) : undefined;
  const rules = createRulesService(store, { matcher });
  const imports = createImportService(store, { env, rules });
  const server = createAppServer({ rules, imports, webDir });
  const address = await listen(server, port);
  log(`Sally is running at ${address}`);
  const stop = () => {
    server.close();
    server.closeAllConnections();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
