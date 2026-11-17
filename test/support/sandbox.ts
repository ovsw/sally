import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  /** Runs `fn` with the rules service on the sandbox database. */
  withRules<T>(fn: (rules: RulesService) => T): T;
  /** Adds a rule and publishes it; returns its id. */
  liveRule(rule: Partial<NewRule> & { name: string }): number;
  /** Runs a read-only SQL query against the sandbox database. */
  query<T = Record<string, unknown>>(sql: string, ...params: (string | number)[]): T[];
  cleanup(): void;
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "sally-test-"));
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
    withRules,
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
      rmSync(root, { recursive: true, force: true });
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
