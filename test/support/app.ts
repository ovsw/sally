import type { Server } from "node:http";
import { createAppServer, listen } from "../../src/app/server.ts";
import type { Matcher } from "../../src/matcher.ts";
import { databasePath } from "../../src/paths.ts";
import { createRulesService } from "../../src/rules.ts";
import { openStore } from "../../src/store.ts";
import type { Sandbox } from "./sandbox.ts";

export interface RunningApp {
  address: string;
  /** Calls the app's HTTP interface; JSON bodies are sent as JSON. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Calls it and returns the parsed JSON answer, failing on a non-2xx status. */
  json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

/**
 * Starts the app's server on a free port of this machine, on the sandbox
 * database. Re-scoring uses `matcher`, a stand-in; without one there is no API key.
 */
export async function startApp(
  sandbox: Sandbox,
  options: { webDir?: string; matcher?: Matcher } = {},
): Promise<RunningApp> {
  const store = openStore(databasePath(sandbox.env));
  const server: Server = createAppServer({
    rules: createRulesService(store, { matcher: options.matcher }),
    webDir: options.webDir,
  });
  const address = await listen(server, 0);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(address + path, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    address,
    call,
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await call(method, path, body);
      const parsed = (await response.json()) as T;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(parsed)}`);
      return parsed;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };
}
