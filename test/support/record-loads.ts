// Preloaded with --import: appends the URL of every module the process loads
// to the file named by SALLY_TEST_LOADS, one per line.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const file = process.env.SALLY_TEST_LOADS;
if (file) {
  registerHooks({
    load(url, context, nextLoad) {
      appendFileSync(file, url + "\n");
      return nextLoad(url, context);
    },
  });
}
