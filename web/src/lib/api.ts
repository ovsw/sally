// The app's HTTP interface (src/app/api.ts). The shapes mirror the rules
// service's; they are repeated here so the browser code never imports server
// code.

export type CheckType = "message" | "reply";

export interface RuleSummary {
  id: number;
  name: string;
  /** The checks the rule takes part in: those its conditions in force are on for, message first. */
  checkTypes: CheckType[];
  /** True once the rule has a published version. */
  published: boolean;
  /** The scope in force: the published version's, or the draft's before the first publish. */
  scope: Scope;
  on: boolean;
  hasDraft: boolean;
}

/** All projects, or only the named ones (owner/name, or a folder path). */
export type Scope = { kind: "all" } | { kind: "projects"; projects: string[] };

/** Which checks use a condition. With both off, the condition is off. */
export interface Switches {
  message: boolean;
  reply: boolean;
}

/** A condition as a version words it, with its switches as they are now. */
export interface ConditionView extends Switches {
  id: number;
  text: string;
}

/** A condition in a form: a new one has no id until the server has it. */
export interface ConditionDraft extends Switches {
  id?: number;
  text: string;
}

/** What a draft holds, as the forms edit it and the server saves it. */
export interface DraftContent {
  name: string;
  instruction: string;
  conditions: ConditionDraft[];
  scope: Scope;
}

export interface VersionView {
  name: string;
  instruction: string;
  conditions: ConditionView[];
  scope: Scope;
}

export interface Project {
  name: string;
  firstSeenAt: string;
}

export interface PublishedVersion extends VersionView {
  number: number;
  publishedAt: string;
}

export interface RuleDetail extends RuleSummary {
  live: PublishedVersion | null;
  draft: (VersionView & { savedAt: string }) | null;
  /** Every published version, newest first. */
  versions: PublishedVersion[];
}

export interface RuleFilter {
  search?: string;
  checkType?: CheckType[];
  published?: boolean[];
  on?: boolean[];
  hasDraft?: boolean[];
  allProjects?: boolean[];
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
 * The server filters each of these by one value; picking both
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
  for (const key of ["published", "on", "hasDraft", "allProjects"] as const) {
    const value = single(filter[key]);
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return call<{ rules: RuleSummary[] }>("GET", `/api/rules${query ? `?${query}` : ""}`).then((r) => r.rules);
}

export function getRule(id: number): Promise<RuleDetail> {
  return call("GET", `/api/rules/${id}`);
}

/** What a new rule is made of: each condition with its wording and its two switches. */
export interface NewRule {
  name: string;
  instruction: string;
  conditions: (Switches & { text: string })[];
  scope?: Scope;
}

export function createRule(rule: NewRule): Promise<RuleDetail> {
  return call("POST", "/api/rules", rule);
}

/** `keepalive` lets the save finish after the page has gone. */
export function saveDraft(id: number, draft: DraftContent, keepalive = false): Promise<RuleDetail> {
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
  replyCutoff: number;
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
  /** The check that sent the largest request; null with no such checks. */
  largestCheck: LargestCheck | null;
}

/** The check behind the largest recent request, and what took up its room. */
export interface LargestCheck {
  checkId: number;
  createdAt: string;
  checkType: CheckType;
  project: string | null;
  /** The start of the text checked, as sent. */
  excerpt: string;
  conditions: number;
  /** About how much of the request the text took, from 0 to 1; the conditions took the rest. */
  textShare: number;
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
  /** The checks the rule takes part in. */
  checkTypes: CheckType[];
  versionNumber: number;
  reasons: AttentionReason[];
}

/** The rules that need attention, worst first. */
export function listAttention(): Promise<AttentionEntry[]> {
  return call<{ rules: AttentionEntry[] }>("GET", "/api/attention").then((r) => r.rules);
}

/**
 * The user judged one of a rule's attention reasons fine, for the version
 * they were shown. Answers with the list as it now is. Wrong matches are refused: they go when the rule is fixed.
 */
export function clearAttentionReason(
  ruleId: number,
  kind: AttentionKind,
  versionNumber: number,
): Promise<AttentionEntry[]> {
  return call<{ rules: AttentionEntry[] }>("POST", `/api/rules/${ruleId}/looks-fine`, {
    reason: kind,
    version: versionNumber,
  }).then((r) => r.rules);
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

/** What the import proposes for a passage. */
export type PassageVerdict = "becomes_rule" | "always_rule" | "too_vague";

export interface ProposedRule {
  id: number;
  /** null once skipped. */
  ruleId: number | null;
  decision: "published" | "kept" | "skipped" | null;
  rule: RuleDetail | null;
}

export interface Passage {
  id: number;
  /** Its place in the rules file: 1 for the first. */
  position: number;
  text: string;
  verdict: PassageVerdict;
  reason: string;
  similarRule: string | null;
  decision: "becomes_rule" | "stays" | null;
  seenAt: string | null;
  pending: boolean;
  rules: ProposedRule[];
}

export interface ImportSummary {
  id: number;
  rulesFile: string;
  scope: Scope;
  createdAt: string;
  removedAt: string | null;
  passageCount: number;
  pendingCount: number;
}

export interface ImportDetail extends ImportSummary {
  passages: Passage[];
}

export function getImport(id: number): Promise<ImportDetail> {
  return call("GET", `/api/imports/${id}`);
}

export function listImports(): Promise<ImportSummary[]> {
  return call<{ imports: ImportSummary[] }>("GET", "/api/imports").then((r) => r.imports);
}

/** Tells the rest of the app, such as the sidebar's pending counts, that an import changed. */
export const IMPORTS_CHANGED = "sally:imports-changed";

/** Makes one decision in an import and answers with the import as it now is. */
async function decide(path: string, body: unknown = {}): Promise<ImportDetail> {
  const detail = await call<ImportDetail>("POST", path, body);
  window.dispatchEvent(new Event(IMPORTS_CHANGED));
  return detail;
}

export function publishProposedRule(proposalId: number): Promise<ImportDetail> {
  return decide(`/api/proposed-rules/${proposalId}/publish`);
}

export function keepProposedRule(proposalId: number): Promise<ImportDetail> {
  return decide(`/api/proposed-rules/${proposalId}/keep`);
}

export function skipProposedRule(proposalId: number): Promise<ImportDetail> {
  return decide(`/api/proposed-rules/${proposalId}/skip`);
}

export function markPassageSeen(passageId: number): Promise<ImportDetail> {
  return decide(`/api/passages/${passageId}/seen`);
}

export function markPassageStays(passageId: number): Promise<ImportDetail> {
  return decide(`/api/passages/${passageId}/stays`);
}

export function writeRule(passageId: number, rule: Omit<NewRule, "scope">): Promise<ImportDetail> {
  return decide(`/api/passages/${passageId}/rules`, rule);
}
