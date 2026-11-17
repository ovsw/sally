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

/** The engine's settings: matching, then the attention thresholds. */
export interface Settings {
  cutoff: number;
  timeLimitMs: number;
  /** Whether a failed check stops the turn. */
  stopOnFailure: boolean;
  recentChecks: number;
  busyShare: number;
  closeMargin: number;
  quietChecks: number;
}

/** How much of Jev's per-request limit recent checks have used. */
export interface LimitUse {
  requestLimit: number;
  warningShare: number;
  checks: number;
  largestRequest: number | null;
  share: number | null;
  warning: boolean;
}

export interface SettingsAnswer {
  settings: Settings;
  limitUse: LimitUse;
}

export function getSettings(): Promise<SettingsAnswer> {
  return call("GET", "/api/settings");
}

export function updateSettings(changes: Partial<Settings>): Promise<SettingsAnswer> {
  return call("PUT", "/api/settings", changes);
}

export type Outcome = "nothing" | "attached" | "sent_back" | "skipped" | "failed";

/** A rule that matched in a check. `name` is null when the rule has since been deleted. */
export interface ActivityMatch {
  ruleId: number;
  name: string | null;
  score: number;
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
  matches: ActivityMatch[];
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

export type Verdict = "wrong" | "right";
export type RaisedBy = "claude" | "user";

/** A verdict on one match and who raised it. */
export interface Flag {
  verdict: Verdict;
  raisedBy: RaisedBy;
  createdAt: string;
}

export interface RuleMatch extends RuleCheckView {
  matchId: number;
  flag: Flag | null;
}

export interface RuleAnalytics {
  checks: number;
  matches: number;
  wrongMatches: number;
  recentMatches: RuleMatch[];
  nearMisses: RuleCheckView[];
  nearMissMargin: number;
  versions: { number: number; publishedAt: string; checks: number; matches: number; wrongMatches: number }[];
}

export function getRuleAnalytics(id: number): Promise<RuleAnalytics> {
  return call("GET", `/api/rules/${id}/analytics`);
}

/** Why a rule needs attention, worst first. */
export type AttentionKind = "wrong_matches" | "matches_often" | "weak_matches" | "never_matches";

export interface AttentionReason {
  kind: AttentionKind;
  /** Why, in a sentence. */
  summary: string;
}

/** A rule on the Needs attention list, with every reason it is there. */
export interface AttentionEntry {
  ruleId: number;
  name: string;
  checkType: CheckType;
  versionNumber: number;
  reasons: AttentionReason[];
}

/** The rules that need attention, worst first. */
export function listAttention(): Promise<AttentionEntry[]> {
  return call<{ rules: AttentionEntry[] }>("GET", "/api/attention").then((r) => r.rules);
}

/**
 * The user judged one of a rule's attention reasons fine. Answers with the
 * list as it now is. Wrong matches are refused: they go when the rule is fixed.
 */
export function clearAttentionReason(ruleId: number, kind: AttentionKind): Promise<AttentionEntry[]> {
  return call<{ rules: AttentionEntry[] }>("POST", `/api/rules/${ruleId}/looks-fine`, { reason: kind }).then(
    (r) => r.rules,
  );
}

/** The user marks a match wrong or right; it becomes a saved case for its rule. */
export function flagMatch(matchId: number, verdict: Verdict): Promise<{ flag: Flag; recorded: boolean }> {
  return call("POST", `/api/matches/${matchId}/flag`, { verdict });
}

/** A real message or reply kept with a rule, with the outcome it should have. */
export interface SavedCase {
  id: number;
  ruleId: number;
  checkType: CheckType;
  text: string;
  expected: "should_match" | "should_not_match";
  createdAt: string;
  source: { verdict: Verdict; raisedBy: RaisedBy; checkId: number; versionNumber: number | null } | null;
}

export function listSavedCases(ruleId: number): Promise<SavedCase[]> {
  return call<{ cases: SavedCase[] }>("GET", `/api/rules/${ruleId}/cases`).then((r) => r.cases);
}

/** How one saved case fares against the draft's conditions. */
export interface CaseResult {
  case: SavedCase;
  scores: { condition: string; score: number }[];
  best: number;
  /** The rule would match the case: a condition reaches the cutoff. */
  matched: boolean;
  /** That is what the case expects. */
  passed: boolean;
}

/** The draft scored against the rule's saved cases. A failure never blocks publishing. */
export type RescoreResult =
  | { status: "scored"; cutoff: number; cases: CaseResult[]; passed: number; failed: number }
  | { status: "no_cases"; cutoff: number }
  | { status: "failed"; cutoff: number; error: string; caseCount: number };

/** Scores the draft's conditions against the rule's saved cases with Jev. Changes nothing. */
export function rescoreDraft(id: number): Promise<RescoreResult> {
  return call("POST", `/api/rules/${id}/rescore`, {});
}
