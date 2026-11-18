import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Starting processes and writing the database are several times slower on
    // Windows runners; the default limit of 5 seconds fails tests that pass.
    testTimeout: process.platform === "win32" ? 180_000 : 5_000,
  },
});
