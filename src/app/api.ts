import type { IncomingMessage, ServerResponse } from "node:http";
import { type ActivityFilter, OUTCOMES } from "../analytics.ts";
import type { AttentionKind } from "../attention.ts";
import type { Outcome } from "../engine.ts";
import { type Verdict, VERDICTS } from "../flags.ts";
import type { ImportService } from "../import.ts";
import {
  type CheckType,
  type RuleFilter,
  RuleError,
  RuleNotFoundError,
  type RulesService,
  type Scope,
  type Settings,
} from "../rules.ts";

/** A request the API refuses, with the HTTP status to answer with. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  // Requiring JSON keeps other web pages from posting here with a plain form.
  if (!type.startsWith("application/json")) throw new HttpError(415, "Send JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Send a JSON object.");
  }
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `"${key}" must be text.`);
  return value;
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : text(body, key);
}

function textList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new HttpError(400, `"${key}" must be a list of text.`);
  }
  return value;
}

/** The scope, when given: { kind: "all" } or { kind: "projects", projects: [...] }. */
function optionalScope(body: Record<string, unknown>, key: string): Scope | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) {
    const { kind, projects } = value as { kind?: unknown; projects?: unknown };
    if (kind === "all") return { kind: "all" };
    if (kind === "projects" && Array.isArray(projects) && projects.every((p) => typeof p === "string")) {
      return { kind: "projects", projects };
    }
  }
  throw new HttpError(400, `"${key}" must be all projects or a list of projects.`);
}

const SETTING_NAMES: (keyof Settings)[] = [
  "cutoff",
  "replyCutoff",
  "timeLimitMs",
  "stopOnFailure",
  "recentChecks",
  "busyShare",
  "closeMargin",
  "quietChecks",
];

/** The settings given in the body: stopOnFailure must be true or false, every other a number. Unknown keys are refused. */
function settingsFrom(body: Record<string, unknown>): Partial<Settings> {
  const changes: Partial<Settings> = {};
  for (const [name, value] of Object.entries(body)) {
    const key = SETTING_NAMES.find((setting) => setting === name);
    if (!key) throw new HttpError(400, `"${name}" is not a setting.`);
    if (key === "stopOnFailure") {
      if (typeof value !== "boolean") throw new HttpError(400, `"${name}" must be true or false.`);
      changes[key] = value;
    } else {
      if (typeof value !== "number") throw new HttpError(400, `"${name}" must be a number.`);
      changes[key] = value;
    }
  }
  return changes;
}

function filterFrom(params: URLSearchParams): RuleFilter {
  const filter: RuleFilter = {};
  const search = params.get("search");
  if (search) filter.search = search;
  const checkType = params.get("checkType");
  if (checkType === "message" || checkType === "reply") filter.checkType = checkType;
  else if (checkType) throw new HttpError(400, "checkType is message or reply.");
  for (const key of ["published", "on", "hasDraft", "allProjects"] as const) {
    const value = params.get(key);
    if (value === "true" || value === "false") filter[key] = value === "true";
    else if (value !== null) throw new HttpError(400, `${key} is true or false.`);
  }
  return filter;
}

function activityFilterFrom(params: URLSearchParams): ActivityFilter {
  const filter: ActivityFilter = {};
  const outcomes = params.getAll("outcome");
  if (!outcomes.every((o) => OUTCOMES.includes(o as Outcome))) {
    throw new HttpError(400, `outcome is one of ${OUTCOMES.join(", ")}.`);
  }
  if (outcomes.length > 0) filter.outcomes = outcomes as Outcome[];
  const checkType = params.get("checkType");
  if (checkType === "message" || checkType === "reply") filter.checkType = checkType;
  else if (checkType) throw new HttpError(400, "checkType is message or reply.");
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^\d+$/.test(limit)) throw new HttpError(400, "limit is a whole number.");
    filter.limit = Number(limit);
  }
  return filter;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** One of the user's decisions in an import (see ImportDecisions). */
async function handleDecision(
  imports: ImportService,
  parts: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const id = Number(parts[1]);
  if (parts.length !== 3 || !Number.isSafeInteger(id)) throw new HttpError(404, "Not found.");
  const body = await readJson(req);
  const action = `${parts[0]}/${parts[2]}`;
  if (action === "proposed-rules/publish") return send(res, 200, imports.publishProposedRule(id));
  if (action === "proposed-rules/keep") return send(res, 200, imports.keepProposedRule(id));
  if (action === "proposed-rules/skip") return send(res, 200, imports.skipProposedRule(id));
  if (action === "passages/seen") return send(res, 200, imports.markPassageSeen(id));
  if (action === "passages/stays") return send(res, 200, imports.markPassageStays(id));
  if (action === "passages/rules") {
    const detail = imports.writeRule(id, {
      name: text(body, "name"),
      checkType: text(body, "checkType") as CheckType,
      instruction: text(body, "instruction"),
      conditions: textList(body, "conditions"),
    });
    return send(res, 201, detail);
  }
  throw new HttpError(404, "Not found.");
}

/**
 * The rules service over HTTP, under /api:
 *
 * - GET  /api/rules?search=&checkType=&state=&hasDraft=  the rules list (state may repeat)
 * - POST /api/rules                                      create a rule (a draft only)
 * - GET  /api/rules/:id                                  a rule, live version and draft
 * - PUT  /api/rules/:id/draft                            save the draft
 * - POST /api/rules/:id/rescore                          score the draft's conditions against the saved cases
 * - POST /api/rules/:id/publish                          publish the draft
 * - DELETE /api/rules/:id/draft                          discard the draft
 * - POST /api/rules/:id/versions/:number/draft           start a draft from a published version
 * - POST /api/rules/:id/off, POST /api/rules/:id/on      switch the rule off or on
 * - DELETE /api/rules/:id                                delete the rule
 * - GET  /api/rules/:id/analytics                        how the rule has behaved
 * - GET  /api/rules/:id/cases                            the rule's saved cases
 * - POST /api/matches/:id/flag                           the user marks a match { verdict: wrong|right }
 * - GET  /api/projects                                   the projects Sally has seen
 * - GET  /api/settings                                   { settings, limitUse }: the settings, and how
 *                                                        much of Jev's request limit recent checks used
 * - PUT  /api/settings                                   change some settings; answers like GET
 * - GET  /api/activity?outcome=&checkType=&limit=        the most recent checks
 * - GET  /api/attention                                  the rules that need attention, and why
 * - POST /api/rules/:id/looks-fine                       the user judged one attention reason fine { reason };
 *                                                        answers like GET /api/attention
 * - GET  /api/imports                                    every import, newest first, with its pending count
 * - GET  /api/imports/:id                                an import, its passages and the rules they produced
 * - POST /api/proposed-rules/:id/publish|keep|skip       decide one proposed rule
 * - POST /api/passages/:id/seen                          the user has seen the passage
 * - POST /api/passages/:id/stays                         the passage stays in the rules file; its rules are skipped
 * - POST /api/passages/:id/rules                         write a rule for the passage { name, checkType, instruction, conditions }
 *   Each import decision answers with the import as it now is.
 *
 * Every change answers with the rule as it now is, except a delete, which
 * answers { deleted: true }, a flag, which answers with the match's flag,
 * and a re-score, which changes nothing and answers with which saved cases
 * pass (a Jev failure is part of that answer, not a refusal). Refusals answer
 * with { error } and a 4xx status.
 */
export async function handleApi(
  rules: RulesService,
  imports: ImportService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = req.method ?? "GET";
    if (parts[0] === "imports" && method === "GET") {
      if (parts.length === 1) return send(res, 200, { imports: imports.listImports() });
      const importId = Number(parts[1]);
      if (parts.length === 2 && Number.isSafeInteger(importId)) return send(res, 200, imports.getImport(importId));
      throw new HttpError(404, "Not found.");
    }
    if ((parts[0] === "proposed-rules" || parts[0] === "passages") && method === "POST") {
      return await handleDecision(imports, parts, req, res);
    }
    if (parts.length === 1 && parts[0] === "projects" && method === "GET") {
      return send(res, 200, { projects: rules.projects() });
    }
    if (parts.length === 1 && parts[0] === "settings" && method === "GET") {
      return send(res, 200, { settings: rules.settings(), limitUse: rules.limitUse() });
    }
    if (parts.length === 1 && parts[0] === "settings" && method === "PUT") {
      const settings = rules.updateSettings(settingsFrom(await readJson(req)));
      return send(res, 200, { settings, limitUse: rules.limitUse() });
    }
    if (parts.length === 1 && parts[0] === "activity" && method === "GET") {
      return send(res, 200, { checks: rules.activity(activityFilterFrom(url.searchParams)) });
    }
    if (parts.length === 1 && parts[0] === "attention" && method === "GET") {
      return send(res, 200, { rules: rules.attention() });
    }
    if (parts.length === 3 && parts[0] === "matches" && parts[2] === "flag" && method === "POST") {
      const matchId = Number(parts[1]);
      if (!Number.isSafeInteger(matchId)) throw new HttpError(404, "Not found.");
      const verdict = (await readJson(req)).verdict;
      if (!VERDICTS.includes(verdict as Verdict)) throw new HttpError(400, '"verdict" is wrong or right.');
      return send(res, 200, rules.flagMatch(matchId, verdict as Verdict, "user"));
    }
    if (parts[0] !== "rules") throw new HttpError(404, "Not found.");
    const id = parts[1] === undefined ? undefined : Number(parts[1]);
    if (id !== undefined && !Number.isSafeInteger(id)) throw new HttpError(404, "Not found.");

    if (parts.length === 1 && method === "GET") {
      return send(res, 200, { rules: rules.listRules(filterFrom(url.searchParams)) });
    }
    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const { ruleId } = rules.createRule({
        name: text(body, "name"),
        checkType: text(body, "checkType") as CheckType,
        instruction: text(body, "instruction"),
        conditions: textList(body, "conditions"),
        scope: optionalScope(body, "scope"),
      });
      return send(res, 201, rules.getRule(ruleId));
    }
    if (id !== undefined && parts.length === 2 && method === "GET") {
      return send(res, 200, rules.getRule(id));
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "analytics" && method === "GET") {
      return send(res, 200, rules.ruleAnalytics(id));
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "cases" && method === "GET") {
      return send(res, 200, { cases: rules.savedCases(id) });
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "draft" && method === "PUT") {
      const body = await readJson(req);
      rules.saveDraft(id, {
        name: optionalText(body, "name"),
        instruction: text(body, "instruction"),
        conditions: textList(body, "conditions"),
        scope: optionalScope(body, "scope"),
      });
      return send(res, 200, rules.getRule(id));
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "rescore" && method === "POST") {
      await readJson(req);
      return send(res, 200, await rules.rescoreDraft(id));
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "publish" && method === "POST") {
      await readJson(req);
      const { versionNumber } = rules.publish(id);
      return send(res, 200, { versionNumber, rule: rules.getRule(id) });
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "draft" && method === "DELETE") {
      rules.discardDraft(id);
      return send(res, 200, rules.getRule(id));
    }
    if (id !== undefined && parts.length === 5 && parts[2] === "versions" && parts[4] === "draft" && method === "POST") {
      const versionNumber = Number(parts[3]);
      if (!Number.isSafeInteger(versionNumber)) throw new HttpError(404, "Not found.");
      await readJson(req);
      rules.startDraftFrom(id, versionNumber);
      return send(res, 200, rules.getRule(id));
    }
    if (id !== undefined && parts.length === 3 && (parts[2] === "off" || parts[2] === "on") && method === "POST") {
      await readJson(req);
      if (parts[2] === "off") rules.switchOff(id);
      else rules.switchOn(id);
      return send(res, 200, rules.getRule(id));
    }
    if (id !== undefined && parts.length === 3 && parts[2] === "looks-fine" && method === "POST") {
      const body = await readJson(req);
      const version = body["version"];
      if (version !== undefined && typeof version !== "number") throw new HttpError(400, '"version" must be a number.');
      rules.clearAttentionReason(id, text(body, "reason") as AttentionKind, version);
      return send(res, 200, { rules: rules.attention() });
    }
    if (id !== undefined && parts.length === 2 && method === "DELETE") {
      rules.deleteRule(id);
      return send(res, 200, { deleted: true });
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    if (error instanceof RuleNotFoundError) return send(res, 404, { error: error.message });
    if (error instanceof RuleError) return send(res, 400, { error: error.message });
    return send(res, 500, { error: "Something went wrong." });
  }
}
