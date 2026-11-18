// `pnpm dev`: the web app with hot reload on sample data.
//
// Runs the app's API and the Vite dev server in one process, on a database in
// .dev/ (git-ignored) and the stand-in matcher. It never reads the real
// database or the Jev API key. `pnpm dev --fresh` starts the sample data over.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createAppServer, listen } from "../src/app/server.ts";
import { createImportService } from "../src/import.ts";
import { databasePath } from "../src/paths.ts";
import { createRulesService } from "../src/rules.ts";
import { openStore } from "../src/store.ts";
import { devMatcher } from "./matcher.ts";
import { devEnv, seed } from "./seed.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = join(packageRoot, ".dev");
const database = databasePath({ SALLY_DATA_DIR: join(root, "data") });

if (process.argv.includes("--fresh") || !existsSync(database)) {
  console.log("Writing sample data to .dev/ ...");
  await seed(root);
}

const store = openStore(database);
const rules = createRulesService(store, { matcher: devMatcher() });
const api = createAppServer({
  rules,
  // The sample import's rules file sits under .dev/home, so its scope reads as it would for real.
  imports: createImportService(store, { env: devEnv(root), rules }),
  // Pages come from Vite; the app serves only /api here.
  webDir: join(packageRoot, "dist", "web"),
});
// Any free port, so this runs next to a real `sally app`.
process.env.SALLY_API = await listen(api, 0);

const vite = await createServer({ configFile: join(packageRoot, "vite.config.ts") });
await vite.listen();
console.log("Sally (sample data) is running at:");
vite.printUrls();

const stop = () => {
  void vite.close();
  api.close();
  api.closeAllConnections();
  store.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
