import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { ImportService } from "../import.ts";
import type { RulesService } from "../rules.ts";
import { handleApi } from "./api.ts";

/** The app listens on this machine only. */
export const HOST = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export interface AppServerOptions {
  rules: RulesService;
  imports: ImportService;
  /** The built web app. Without it only the API is served. */
  webDir?: string;
}

/**
 * Only requests addressed to this machine by name are served, so a page on
 * another site cannot reach the app through a hostname it controls.
 */
function addressedLocally(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

/** A browser sends Origin on cross-site requests; only the app's own pages may change anything. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveFile(res: ServerResponse, webDir: string, pathname: string): void {
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = resolve(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  // The app routes on the client, so any unknown path gets the page itself.
  if (!isFile(file)) file = join(root, "index.html");
  if (!isFile(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("The web app is not built.");
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}

export function createAppServer(options: AppServerOptions): Server {
  return createServer((req, res) => {
    if (!addressedLocally(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && !sameOrigin(req)) {
        res.writeHead(403).end();
        return;
      }
      void handleApi(options.rules, options.imports, req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (!options.webDir) {
      res.writeHead(404).end();
      return;
    }
    serveFile(res, options.webDir, url.pathname);
  });
}

/** Starts listening on this machine only and resolves with the app's address. */
export function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolvePromise(`http://${HOST}:${address.port}`);
    });
  });
}
