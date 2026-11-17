// The app's HTTP interface (src/app/api.ts). The shapes mirror the rules
// service's; they are repeated here so the browser code never imports server
// code.

export type CheckType = "message" | "reply";
export type RuleState = "live" | "draft" | "off";

export interface RuleSummary {
  id: number;
  name: string;
  checkType: CheckType;
  state: RuleState;
  on: boolean;
  hasDraft: boolean;
}

/** All projects, or only the named ones (owner/name, or a folder path). */
export type Scope = { kind: "all" } | { kind: "projects"; projects: string[] };

export interface VersionView {
  name: string;
  instruction: string;
  conditions: string[];
  scope: Scope;
}

/** A version as the server returns it: with the check type it runs on. */
export interface StoredVersion extends VersionView {
  checkType: CheckType;
}

export interface Project {
  name: string;
  firstSeenAt: string;
}

export interface PublishedVersion extends StoredVersion {
  number: number;
  publishedAt: string;
}

export interface RuleDetail extends RuleSummary {
  live: PublishedVersion | null;
  draft: (StoredVersion & { savedAt: string }) | null;
  /** Every published version, newest first. */
  versions: PublishedVersion[];
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
 * The server filters check type and draft by one value each; picking both
 * values of one of them is the same as picking none.
 */
function single<T>(values: T[] | undefined): T | undefined {
  return values && values.length === 1 ? values[0] : undefined;
}

export function listRules(filter: RuleFilter): Promise<RuleSummary[]> {
  const params = new URLSearchParams();
  if (filter.search?.trim()) params.set("search", filter.search.trim());
  const checkType = single(filter.checkType);
  if (checkType) params.set("checkType", checkType);
  for (const state of filter.state ?? []) params.append("state", state);
  const hasDraft = single(filter.hasDraft);
  if (hasDraft !== undefined) params.set("hasDraft", String(hasDraft));
  const query = params.toString();
  return call<{ rules: RuleSummary[] }>("GET", `/api/rules${query ? `?${query}` : ""}`).then((r) => r.rules);
}

export function getRule(id: number): Promise<RuleDetail> {
  return call("GET", `/api/rules/${id}`);
}

export function createRule(
  rule: Omit<VersionView, "scope"> & { checkType: CheckType; scope?: Scope },
): Promise<RuleDetail> {
  return call("POST", "/api/rules", rule);
}

/** `keepalive` lets the save finish after the page has gone. */
export function saveDraft(id: number, draft: VersionView, keepalive = false): Promise<RuleDetail> {
  return call("PUT", `/api/rules/${id}/draft`, draft, keepalive);
}

export function publish(id: number): Promise<{ versionNumber: number; rule: RuleDetail }> {
  return call("POST", `/api/rules/${id}/publish`, {});
}

export function discardDraft(id: number): Promise<RuleDetail> {
  return call("DELETE", `/api/rules/${id}/draft`);
}

export function startDraftFrom(id: number, versionNumber: number): Promise<RuleDetail> {
  return call("POST", `/api/rules/${id}/versions/${versionNumber}/draft`, {});
}

export function switchRule(id: number, on: boolean): Promise<RuleDetail> {
  return call("POST", `/api/rules/${id}/${on ? "on" : "off"}`, {});
}

export function deleteRule(id: number): Promise<{ deleted: true }> {
  return call("DELETE", `/api/rules/${id}`);
}

/** The projects Sally has seen, by name. */
export function listProjects(): Promise<Project[]> {
  return call<{ projects: Project[] }>("GET", "/api/projects").then((r) => r.projects);
}

export type Outcome = "nothing" | "attached" | "sent_back" | "skipped" | "failed";

/** A rule that fired in a check. `name` is null when the rule has since been deleted. */
export interface ActivityFiring {
  ruleId: number;
  name: string | null;
  score: number;
  /** The cap dropped it, so it was not attached or sent back. */
  dropped: boolean;
}

export interface ActivityCheck {
  id: number;
  createdAt: string;
  project: string | null;
  sessionId: string | null;
  checkType: CheckType;
  text: string;
  outcome: Outcome;
  error: string | null;
  durationMs: number;
  inputTokens: number | null;
  firings: ActivityFiring[];
}

export interface ActivityFilter {
  outcomes?: Outcome[];
  checkType?: CheckType[];
}

/** The most recent checks, newest first. */
export function listActivity(filter: ActivityFilter): Promise<ActivityCheck[]> {
  const params = new URLSearchParams();
  for (const outcome of filter.outcomes ?? []) params.append("outcome", outcome);
  const checkType = single(filter.checkType);
  if (checkType) params.set("checkType", checkType);
  const query = params.toString();
  return call<{ checks: ActivityCheck[] }>("GET", `/api/activity${query ? `?${query}` : ""}`).then((r) => r.checks);
}

export interface RuleCheckView {
  checkId: number;
  createdAt: string;
  project: string | null;
  text: string;
  score: number;
  cutoff: number;
  versionNumber: number | null;
  condition: string | null;
}

export interface RuleAnalytics {
  checks: number;
  firings: number;
  dropped: number;
  recentFirings: (RuleCheckView & { dropped: boolean })[];
  nearMisses: RuleCheckView[];
  nearMissMargin: number;
  versions: { number: number; publishedAt: string; checks: number; firings: number }[];
}

export function getRuleAnalytics(id: number): Promise<RuleAnalytics> {
  return call("GET", `/api/rules/${id}/analytics`);
}
