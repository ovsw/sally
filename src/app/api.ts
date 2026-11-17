import type { IncomingMessage, ServerResponse } from "node:http";
import { type ActivityFilter, OUTCOMES } from "../analytics.ts";
import type { Outcome } from "../engine.ts";
import {
  type CheckType,
  type RuleFilter,
  RuleError,
  RuleNotFoundError,
  type RulesService,
  type RuleState,
  type Scope,
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

function filterFrom(params: URLSearchParams): RuleFilter {
  const filter: RuleFilter = {};
  const search = params.get("search");
  if (search) filter.search = search;
  const checkType = params.get("checkType");
  if (checkType === "message" || checkType === "reply") filter.checkType = checkType;
  else if (checkType) throw new HttpError(400, "checkType is message or reply.");
  const states = params.getAll("state").filter(Boolean);
  if (!states.every((state) => state === "live" || state === "draft" || state === "off")) {
    throw new HttpError(400, "state is live, draft or off.");
  }
  if (states.length) filter.state = states as RuleState[];
  const hasDraft = params.get("hasDraft");
  if (hasDraft === "true" || hasDraft === "false") filter.hasDraft = hasDraft === "true";
  else if (hasDraft) throw new HttpError(400, "hasDraft is true or false.");
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

/**
 * The rules service over HTTP, under /api:
 *
 * - GET  /api/rules?search=&checkType=&state=&hasDraft=  the rules list (state may repeat)
 * - POST /api/rules                                      create a rule (a draft only)
 * - GET  /api/rules/:id                                  a rule, live version and draft
 * - PUT  /api/rules/:id/draft                            save the draft
 * - POST /api/rules/:id/publish                          publish the draft
 * - DELETE /api/rules/:id/draft                          discard the draft
 * - POST /api/rules/:id/versions/:number/draft           start a draft from a published version
 * - POST /api/rules/:id/off, POST /api/rules/:id/on      switch the rule off or on
 * - DELETE /api/rules/:id                                delete the rule
 * - GET  /api/rules/:id/analytics                        how the rule has behaved
 * - GET  /api/projects                                   the projects Sally has seen
 * - GET  /api/activity?outcome=&checkType=&limit=        the most recent checks
 * - GET  /api/attention                                  the rules that need attention, and why
 *
 * Every change answers with the rule as it now is, except a delete, which
 * answers { deleted: true }. Refusals answer with { error } and a 4xx status.
 */
export async function handleApi(
  rules: RulesService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = req.method ?? "GET";
    if (parts.length === 1 && parts[0] === "projects" && method === "GET") {
      return send(res, 200, { projects: rules.projects() });
    }
    if (parts.length === 1 && parts[0] === "activity" && method === "GET") {
      return send(res, 200, { checks: rules.activity(activityFilterFrom(url.searchParams)) });
    }
    if (parts.length === 1 && parts[0] === "attention" && method === "GET") {
      return send(res, 200, { rules: rules.attention() });
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
