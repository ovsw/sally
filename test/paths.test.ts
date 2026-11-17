import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, databasePath, readApiKey } from "../src/paths.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sally-paths-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("where Sally keeps its files", () => {
  it("keeps the database in the user's data folder", () => {
    expect(databasePath({ HOME: home })).toBe(join(home, ".local", "share", "sally", "sally.db"));
    expect(databasePath({ HOME: home, XDG_DATA_HOME: join(home, "data") })).toBe(join(home, "data", "sally", "sally.db"));
  });

  it("reads the API key from the environment first", () => {
    mkdirSync(configDir({ HOME: home }), { recursive: true });
    writeFileSync(join(configDir({ HOME: home }), "api_key"), "from-file\n", { mode: 0o600 });
    expect(readApiKey({ HOME: home, TYPESAFE_API_KEY: "from-env" })).toBe("from-env");
  });

  it("reads the API key from the private file in the user's config folder", () => {
    const dir = join(home, ".config", "sally");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api_key"), "  from-file\n", { mode: 0o600 });
    expect(readApiKey({ HOME: home })).toBe("from-file");
  });

  it("finds no API key when neither holds one", () => {
    expect(readApiKey({ HOME: home })).toBeUndefined();
  });
});
