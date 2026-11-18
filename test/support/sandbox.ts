import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createImportService, type ImportService } from "../../src/import.ts";
import type { Env } from "../../src/paths.ts";
import { databasePath } from "../../src/paths.ts";
import { createRulesService, type NewRule, type RulesService } from "../../src/rules.ts";
import { openStore } from "../../src/store.ts";

/**
 * A throwaway home, data folder and config folder, so that nothing touches the
 * user's real database, settings or API key.
 */
export interface Sandbox {
  root: string;
  env: Env;
  /**
   * The environment for a child process: the sandbox's folders, PATH, and on
   * Windows the system folder Node needs, and nothing else from the real one.
   * It skips the download of the dependencies in sally-install, so no test
   * downloads anything.
   */
  childEnv(extra?: Env): Env;
  /** Runs `fn` with the rules service on the sandbox database. */
  withRules<T>(fn: (rules: RulesService) => T): T;
  /** Runs `fn` with the import service on the sandbox database. */
  withImports<T>(fn: (imports: ImportService) => T): T;
  /** Adds a rule and publishes it; returns its id. */
  liveRule(rule: Partial<NewRule> & { name: string }): number;
  /** Runs a read-only SQL query against the sandbox database. */
  query<T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[];
  cleanup(): void;
}

export function createSandbox(): Sandbox {
  // The native real path: on Windows the temporary folder can come back in its
  // short 8.3 form, which git and Node then report differently.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sally-test-")));
  const env: Env = {
    HOME: root,
    SALLY_DATA_DIR: join(root, "data"),
    SALLY_CONFIG_DIR: join(root, "config"),
  };
  const withRules = <T>(fn: (rules: RulesService) => T): T => {
    const store = openStore(databasePath(env));
    try {
      return fn(createRulesService(store));
    } finally {
      store.close();
    }
  };
  return {
    root,
    env,
    childEnv(extra = {}) {
      const system = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {};
      return { PATH: process.env.PATH, ...system, ...env, SALLY_SKIP_DEPENDENCIES: "1", ...extra };
    },
    withRules,
    withImports(fn) {
      const store = openStore(databasePath(env));
      try {
        return fn(createImportService(store, { env }));
      } finally {
        store.close();
      }
    },
    liveRule(rule) {
      return withRules((rules) => {
        const { ruleId } = rules.createRule({
          checkType: "message",
          instruction: `Instruction for ${rule.name}.`,
          conditions: [`The message is about ${rule.name}.`],
          ...rule,
        });
        rules.publish(ruleId);
        return ruleId;
      });
    },
    query<T>(sql: string, ...params: (string | number)[]): T[] {
      const db = new DatabaseSync(databasePath(env), { readOnly: true });
      try {
        return db.prepare(sql).all(...params) as T[];
      } finally {
        db.close();
      }
    },
    cleanup() {
      // Retries: Windows refuses to delete a file for a moment after it is closed.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export function hookInput(prompt: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/work/project",
    hook_event_name: "UserPromptSubmit",
    prompt,
    ...extra,
  });
}
