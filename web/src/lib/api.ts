// The app's HTTP interface (src/app/api.ts). The shapes mirror the rules
// service's; they are repeated here so the browser code never imports server
// code.

export type CheckType = "message" | "reply";
export type RuleState = "live" | "draft";

export interface RuleSummary {
  id: number;
  name: string;
  checkType: CheckType;
  state: RuleState;
  hasDraft: boolean;
}

export interface VersionView {
  name: string;
  instruction: string;
  conditions: string[];
}

export interface RuleDetail extends RuleSummary {
  live: (VersionView & { number: number; publishedAt: string }) | null;
  draft: (VersionView & { savedAt: string }) | null;
}

export interface RuleFilter {
  search?: string;
  checkType?: CheckType[];
  state?: RuleState[];
  hasDraft?: boolean[];
}

export class ApiError extends Error {}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  keepalive = false,
): Promise<T> {
  const response = await fetch(path, {
    method,
    keepalive,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(parsed.error ?? `The request failed (${response.status}).`);
  return parsed;
}

/**
 * The server filters by one value per facet; picking every value of a facet
 * is the same as picking none, and picking several of two (the only case
 * here, since each facet has two values) is the same as picking all.
 */
function single<T>(values: T[] | undefined): T | undefined {
  return values && values.length === 1 ? values[0] : undefined;
}

export function listRules(filter: RuleFilter): Promise<RuleSummary[]> {
  const params = new URLSearchParams();
  if (filter.search?.trim()) params.set("search", filter.search.trim());
  const checkType = single(filter.checkType);
  if (checkType) params.set("checkType", checkType);
  const state = single(filter.state);
  if (state) params.set("state", state);
  const hasDraft = single(filter.hasDraft);
  if (hasDraft !== undefined) params.set("hasDraft", String(hasDraft));
  const query = params.toString();
  return call<{ rules: RuleSummary[] }>("GET", `/api/rules${query ? `?${query}` : ""}`).then((r) => r.rules);
}

export function getRule(id: number): Promise<RuleDetail> {
  return call("GET", `/api/rules/${id}`);
}

export function createRule(rule: VersionView & { checkType: CheckType }): Promise<RuleDetail> {
  return call("POST", "/api/rules", rule);
}

/** `keepalive` lets the save finish after the page has gone. */
export function saveDraft(id: number, draft: VersionView, keepalive = false): Promise<RuleDetail> {
  return call("PUT", `/api/rules/${id}/draft`, draft, keepalive);
}

export function publish(id: number): Promise<{ versionNumber: number; rule: RuleDetail }> {
  return call("POST", `/api/rules/${id}/publish`, {});
}
