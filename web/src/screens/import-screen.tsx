// The Import screen: one passage of a rules file at a time, the passage as it
// stands in the file beside what the import proposes for it and why, so the
// user decides each proposed rule on its own: edit it, publish it, keep it as
// a draft or skip it. There are no bulk actions. Cards follow the shadcnblocks
// block card-card-standard-1 (shadcn Card with header, content and footer);
// progress follows progress-progress-basic-4.
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Loader2,
  PenLine,
  Plus,
  SkipForward,
  TerminalSquare,
  TriangleAlert,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";

import { NewRuleDialog } from "@/components/new-rule-dialog";
import { RescoreDialog } from "@/components/rescore-dialog";
import { ConditionsField, InstructionField, NameField, SaveStatus } from "@/components/rule-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
  ApiError,
  discardDraft,
  getImport,
  type ImportDetail,
  keepProposedRule,
  markPassageSeen,
  markPassageStays,
  type Passage,
  type PassageVerdict,
  type ProposedRule,
  publish,
  publishProposedRule,
  rescoreDraft,
  type RescoreResult,
  type RuleDetail,
  type Scope,
  skipProposedRule,
  type VersionView,
  writeRule,
} from "@/lib/api";
import { errorText, useDraftSaver } from "@/lib/draft-saver";
import { followLink, isPlainClick, navigate } from "@/lib/router";

const VERDICTS: Record<PassageVerdict, string> = {
  becomes_rule: "Becomes a rule",
  always_rule: "Stays as an always-rule",
  too_vague: "Stays, too vague to match on",
};

const scopeText = (scope: Scope) => (scope.kind === "all" ? "All projects" : scope.projects.join(", "));

/** Whether the passage stays in the rules file: by its verdict, unless the user overruled it. */
const staysInFile = (passage: Passage) =>
  (passage.decision ?? (passage.verdict === "becomes_rule" ? "becomes_rule" : "stays")) === "stays";

/** The passage to show: the one asked for, else the first still pending. */
function passageToShow(detail: ImportDetail, position: number | undefined): Passage | undefined {
  if (position !== undefined) return detail.passages.find((p) => p.position === position);
  return detail.passages.find((p) => p.pending);
}

const contentOf = (rule: RuleDetail): VersionView => {
  const source = rule.draft ?? rule.live!;
  return {
    name: source.name,
    instruction: source.instruction,
    conditions: source.conditions.length ? [...source.conditions] : [""],
    scope: source.scope,
  };
};

type Decide = (run: () => Promise<ImportDetail>) => Promise<boolean>;

function RuleBody({ version }: { version: VersionView }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">Conditions</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {version.conditions.map((condition, index) => (
            <li key={index}>{condition}</li>
          ))}
        </ul>
      </div>
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">Instruction</h3>
        <p className="text-sm whitespace-pre-wrap">{version.instruction}</p>
      </div>
    </div>
  );
}

/**
 * The link to the rule's own screen. With `save`, edits not yet sent are saved
 * first, so the rule screen opens on them and cannot send the old text back;
 * if the save fails, the user stays here with the edits and the error.
 */
function OpenRuleLink({ ruleId, save }: { ruleId: number; save?: () => Promise<boolean> }) {
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!save || !isPlainClick(event)) return followLink(event);
    event.preventDefault();
    const href = event.currentTarget.pathname;
    void save().then((ok) => ok && navigate(href));
  };
  return (
    <a href={`/rules/${ruleId}`} onClick={onClick} className="text-sm text-muted-foreground hover:underline">
      Open the rule
    </a>
  );
}

/** A proposed rule not yet published: edited in place, then published, kept or skipped. */
function OpenRuleCard({ proposed, rule, decide }: { proposed: ProposedRule; rule: RuleDetail; decide: Decide }) {
  const [content, setContent] = React.useState(() => contentOf(rule));
  const [hasDraft, setHasDraft] = React.useState(rule.hasDraft);
  const [busy, setBusy] = React.useState<"publish" | "keep" | "skip" | "open" | null>(null);
  const onSaved = React.useCallback((saved: RuleDetail) => setHasDraft(saved.hasDraft), []);
  const saver = useDraftSaver(rule.id, onSaved);
  const kept = proposed.decision === "kept";

  const edit = (next: VersionView) => {
    setContent(next);
    saver.saveSoon(next);
  };

  async function act(which: "publish" | "keep" | "skip") {
    setBusy(which);
    if (which === "skip") {
      // Skipping drops edits not yet sent; if the skip fails, they are saved again.
      await saver
        .replacing(async () => {
          if (!(await decide(() => skipProposedRule(proposed.id)))) throw new Error("The skip failed.");
        })
        .catch(() => undefined);
    } else if (await saver.flush()) {
      // Edits are saved first, so what is published or kept is what the user sees.
      const run = which === "publish" ? publishProposedRule : keepProposedRule;
      await decide(() => run(proposed.id));
    }
    setBusy(null);
  }

  // The fields are closed while the save runs, so no edit can be typed after
  // it and left behind; a failed save opens them again.
  async function saveBeforeLeaving() {
    setBusy("open");
    const saved = await saver.flush();
    if (!saved) setBusy(null);
    return saved;
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{content.name.trim() || rule.name}</CardTitle>
          {kept ? <Badge variant="secondary">Kept as a draft</Badge> : <Badge variant="outline">To decide</Badge>}
        </div>
        <CardDescription>
          {rule.checkType === "message" ? "User message" : "Agent reply"} · {scopeText(content.scope)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Closed while a decision runs, so an edit cannot change what is being published. */}
        <fieldset disabled={busy !== null} className="min-w-0">
          <FieldGroup>
            <NameField
              id={`name-${rule.id}`}
              name={content.name}
              onChange={(name) => edit({ ...content, name })}
            />
            <ConditionsField
              conditions={content.conditions}
              checkType={rule.checkType}
              onChange={(conditions) => edit({ ...content, conditions })}
            />
            <InstructionField
              id={`instruction-${proposed.id}`}
              instruction={content.instruction}
              onChange={(instruction) => edit({ ...content, instruction })}
            />
          </FieldGroup>
        </fieldset>
        {saver.state.kind === "error" && (
          <Alert variant="destructive" className="mt-4">
            <TriangleAlert />
            <AlertDescription>{saver.state.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <SaveStatus state={saver.state} hasDraft={hasDraft} />
          <OpenRuleLink ruleId={rule.id} save={saveBeforeLeaving} />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void act("skip")} disabled={busy !== null}>
            {busy === "skip" ? <Loader2 className="animate-spin" /> : <SkipForward />}
            Skip
          </Button>
          {!kept && (
            <Button variant="outline" onClick={() => void act("keep")} disabled={busy !== null}>
              {busy === "keep" ? <Loader2 className="animate-spin" /> : <PenLine />}
              Keep as a draft
            </Button>
          )}
          <Button onClick={() => void act("publish")} disabled={busy !== null}>
            {busy === "publish" ? <Loader2 className="animate-spin" /> : <Upload />}
            Publish
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function ProposedRuleCard({
  proposed,
  importId,
  decide,
}: {
  proposed: ProposedRule;
  importId: number;
  decide: Decide;
}) {
  const rule = proposed.rule;
  if (!rule) {
    return (
      <Card className="w-full border-dashed bg-muted/30 shadow-none">
        <CardHeader>
          <CardTitle className="text-muted-foreground">Skipped</CardTitle>
          <CardDescription>
            Its draft was deleted, so it was never published. A skipped rule cannot come back. Write a new rule if you
            need one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (proposed.decision !== "published") return <OpenRuleCard proposed={proposed} rule={rule} decide={decide} />;
  return <PublishedRuleCard rule={rule} importId={importId} decide={decide} />;
}

/**
 * A published rule: shown as it is live, with a way back into editing it here,
 * so changing it does not take the user out of the import. A rule left with an
 * unpublished draft opens in editing, so the draft is not hidden.
 */
function PublishedRuleCard({ rule, importId, decide }: { rule: RuleDetail; importId: number; decide: Decide }) {
  const [editing, setEditing] = React.useState(rule.hasDraft);
  if (editing) {
    return <EditPublishedCard rule={rule} importId={importId} decide={decide} onDone={() => setEditing(false)} />;
  }
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{rule.live!.name}</CardTitle>
          <Badge className="gap-1">
            <Check className="size-3" />
            Published
          </Badge>
        </div>
        <CardDescription>
          {rule.checkType === "message" ? "User message" : "Agent reply"} · {scopeText(rule.live!.scope)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RuleBody version={rule.live!} />
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm text-muted-foreground hover:underline"
        >
          Edit the rule
        </button>
      </CardFooter>
    </Card>
  );
}

/**
 * A published rule opened for editing on the Import screen. Edits go into the
 * rule's draft as on the Rule screen, and publishing it checks the saved cases
 * first, the same way; the live version stays as it is until then.
 */
function EditPublishedCard({
  rule,
  importId,
  decide,
  onDone,
}: {
  rule: RuleDetail;
  importId: number;
  decide: Decide;
  onDone: () => void;
}) {
  const [content, setContent] = React.useState(() => contentOf(rule));
  const [hasDraft, setHasDraft] = React.useState(rule.hasDraft);
  const [busy, setBusy] = React.useState<"publish" | "discard" | "open" | null>(null);
  const [rescore, setRescore] = React.useState<Exclude<RescoreResult, { status: "no_cases" }> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Read when discarding, after the saves already sent have been answered.
  const draftSaved = React.useRef(rule.hasDraft);
  const onSaved = React.useCallback((saved: RuleDetail) => {
    draftSaved.current = saved.hasDraft;
    setHasDraft(saved.hasDraft);
  }, []);
  const saver = useDraftSaver(rule.id, onSaved);
  const saving = saver.state.kind === "pending" || saver.state.kind === "saving";

  const edit = (next: VersionView) => {
    setContent(next);
    saver.saveSoon(next);
  };

  /**
   * Closes the editor once a publish or discard has gone through, then shows
   * the import as it now is. The change is done even if that refresh fails:
   * the screen shows the refresh's error, and the editor does not offer to
   * publish or discard again a draft that is gone.
   */
  const finish = () => {
    onDone();
    void decide(() => getImport(importId));
  };

  /** Publishes the draft; whether it went through. A refusal is shown on the card. */
  async function publishNow() {
    try {
      await publish(rule.id);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    finish();
  }

  async function doPublish() {
    setBusy("publish");
    setError(null);
    if (await saver.flush()) {
      try {
        const result = await rescoreDraft(rule.id);
        if (result.status !== "no_cases") setRescore(result);
        else await publishNow();
      } catch (e) {
        setError(errorText(e));
      }
    }
    setBusy(null);
  }

  async function publishAnyway() {
    setRescore(null);
    setBusy("publish");
    // The fields are closed while the draft is scored, so what was scored is what is published.
    await publishNow();
    setBusy(null);
  }

  /** Drops the draft, if there is one, and shows the live version again. */
  async function discard() {
    setBusy("discard");
    setError(null);
    let dropped = false;
    try {
      await saver.replacing(async () => {
        if (!draftSaved.current) return;
        await discardDraft(rule.id);
        dropped = true;
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
      return;
    }
    if (dropped) finish();
    else onDone();
  }

  async function saveBeforeLeaving() {
    setBusy("open");
    const saved = await saver.flush();
    if (!saved) setBusy(null);
    return saved;
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{content.name.trim() || rule.name}</CardTitle>
          <Badge className="gap-1">
            <Check className="size-3" />
            Published
          </Badge>
          {hasDraft && <Badge variant="secondary">Changes not published</Badge>}
        </div>
        <CardDescription>
          {rule.checkType === "message" ? "User message" : "Agent reply"} · {scopeText(content.scope)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={busy !== null || rescore !== null} className="min-w-0">
          <FieldGroup>
            <NameField
              id={`name-${rule.id}`}
              name={content.name}
              onChange={(name) => edit({ ...content, name })}
            />
            <ConditionsField
              conditions={content.conditions}
              checkType={rule.checkType}
              onChange={(conditions) => edit({ ...content, conditions })}
            />
            <InstructionField
              id={`instruction-published-${rule.id}`}
              instruction={content.instruction}
              onChange={(instruction) => edit({ ...content, instruction })}
            />
          </FieldGroup>
        </fieldset>
        {(saver.state.kind === "error" || error) && (
          <Alert variant="destructive" className="mt-4">
            <TriangleAlert />
            <AlertDescription>{saver.state.kind === "error" ? saver.state.message : error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <SaveStatus state={saver.state} hasDraft={hasDraft} />
          <OpenRuleLink ruleId={rule.id} save={saveBeforeLeaving} />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => void discard()} disabled={busy !== null}>
            {busy === "discard" ? <Loader2 className="animate-spin" /> : <X />}
            {hasDraft || saving || saver.hasUnsent() ? "Discard changes" : "Cancel"}
          </Button>
          <Button
            onClick={() => void doPublish()}
            disabled={busy !== null || !(hasDraft || saving || saver.hasUnsent())}
          >
            {busy === "publish" ? <Loader2 className="animate-spin" /> : <Upload />}
            Publish
          </Button>
        </div>
      </CardFooter>
      <RescoreDialog result={rescore} onPublish={() => void publishAnyway()} onBack={() => setRescore(null)} />
    </Card>
  );
}

function WriteRuleButton({ passage, decide, label }: { passage: Passage; decide: Decide; label: string }) {
  return (
    <NewRuleDialog<ImportDetail>
      title="Write a rule for this passage"
      description="The rule starts as a draft with this import's scope. Publish, keep or skip it like any proposed rule."
      create={(rule) => writeRule(passage.id, rule)}
      // The import as it is now, not the answer to the create: that answer can
      // arrive after a later decision, and applying it would undo that one.
      onCreated={(detail) => void decide(() => getImport(detail.id))}
      trigger={
        <Button variant="outline">
          <Plus />
          {label}
        </Button>
      }
    />
  );
}

function StaysButton({ passage, decide }: { passage: Passage; decide: Decide }) {
  const drafts = passage.rules.filter((r) => r.decision !== "skipped").length;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost">
          <Undo2 />
          Keep it in the rules file instead
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keep this passage in the rules file?</AlertDialogTitle>
          <AlertDialogDescription>
            The passage stays in the file as it is.{" "}
            {drafts === 1 ? "Its proposed rule is skipped" : `Its ${drafts} proposed rules are skipped`}, and a skipped
            rule cannot come back. You can still write a new rule for it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void decide(() => markPassageStays(passage.id))}>
            Keep it in the file
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PassageCard({ passage, decide }: { passage: Passage; decide: Decide }) {
  const stays = staysInFile(passage);
  const overruled = passage.decision !== null && (passage.decision === "stays") !== (passage.verdict !== "becomes_rule");
  const canStay = !stays && !passage.rules.some((r) => r.decision === "published");
  return (
    <Card className="w-full lg:sticky lg:top-6">
      <CardHeader>
        <CardDescription>The import says</CardDescription>
        <CardTitle className="text-xl">{VERDICTS[passage.verdict]}</CardTitle>
        {overruled && (
          <p className="text-sm font-medium">
            You overruled it: {stays ? "it stays in the rules file." : "it becomes a rule."}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">In the rules file</h3>
          <pre className="rounded-md border bg-muted/50 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap">
            {passage.text}
          </pre>
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Why</h3>
          <p className="text-sm leading-relaxed">{passage.reason}</p>
        </div>
        {passage.similarRule && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Looks like a rule you have</AlertTitle>
            <AlertDescription>{passage.similarRule}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      {(canStay || stays) && (
        <CardFooter className="justify-end">
          {canStay ? (
            <StaysButton passage={passage} decide={decide} />
          ) : (
            <WriteRuleButton passage={passage} decide={decide} label="Write a rule for it" />
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function StaysCard({ passage }: { passage: Passage }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Stays in the rules file</CardTitle>
          {passage.seenAt && (
            <Badge variant="secondary" className="gap-1">
              <Check className="size-3" />
              Seen
            </Badge>
          )}
        </div>
        <CardDescription>
          {passage.verdict === "always_rule" && passage.decision !== "stays"
            ? "Claude Code keeps reading it on every turn. Nothing goes into Sally."
            : "It stays in the file as it is. Nothing goes into Sally."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Nothing to decide here. Read the reason, then go on to the next passage.
        </p>
      </CardContent>
    </Card>
  );
}

function ProgressBar({ detail, passage }: { detail: ImportDetail; passage?: Passage }) {
  const reviewed = detail.passageCount - detail.pendingCount;
  const link = (position: number) => `/imports/${detail.id}/passages/${position}`;
  const previous = passage && passage.position > 1 ? passage.position - 1 : null;
  const next = passage && passage.position < detail.passageCount ? passage.position + 1 : null;
  return (
    <div className="w-full max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          {passage && (
            <span className="font-medium">
              Passage {passage.position} of {detail.passageCount}
            </span>
          )}
          <span className="text-muted-foreground">
            {passage ? " · " : ""}
            {reviewed} of {detail.passageCount} reviewed
          </span>
        </div>
        {passage && (
          <div className="flex gap-2">
            <NavButton href={previous === null ? null : link(previous)}>
              <ArrowLeft />
              Previous
            </NavButton>
            <NavButton href={next === null ? null : link(next)}>
              Next
              <ArrowRight />
            </NavButton>
          </div>
        )}
      </div>
      <Progress
        className="w-full"
        value={detail.passageCount === 0 ? 0 : (reviewed / detail.passageCount) * 100}
        aria-label="Passages reviewed"
      />
    </div>
  );
}

function NavButton({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (href === null) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} onClick={followLink}>
        {children}
      </a>
    </Button>
  );
}

/** What is left once no passage is pending: the cleanup of the rules file, done in Claude Code. */
function Finished({ detail, compact }: { detail: ImportDetail; compact: boolean }) {
  if (detail.removedAt !== null) {
    return (
      <Alert className="max-w-6xl">
        <Check />
        <AlertTitle>This import is done</AlertTitle>
        <AlertDescription>
          The published rules were removed from the rules file on {new Date(detail.removedAt).toLocaleDateString()}.
        </AlertDescription>
      </Alert>
    );
  }
  const message =
    "Go back to Claude Code and say you are done. Claude then removes the published rules from the rules file. It shows you the lines first and makes a backup.";
  if (compact) {
    return (
      <Alert className="max-w-6xl">
        <TerminalSquare />
        <AlertTitle>Every passage is reviewed</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    );
  }
  const rules = detail.passages.flatMap((p) => p.rules);
  const count = (decision: ProposedRule["decision"]) => rules.filter((r) => r.decision === decision).length;
  const stays = detail.passages.filter(staysInFile).length;
  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <TerminalSquare className="size-5" />
          Every passage is reviewed
        </CardTitle>
        <CardDescription>The rules file has not changed yet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed">{message}</p>
        <ul className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[
            [count("published"), "published"],
            [count("kept"), "kept as drafts"],
            [count("skipped"), "skipped"],
            [stays, stays === 1 ? "passage stays" : "passages stay"],
          ].map(([n, label]) => (
            <li key={label} className="rounded-md border p-3">
              <div className="text-2xl font-semibold">{n}</div>
              <div className="text-muted-foreground">{label}</div>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button variant="outline" asChild>
          <a href={`/imports/${detail.id}/passages/1`} onClick={followLink}>
            Look through the passages again
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

export function ImportScreen({ id, position }: { id: number; position?: number }) {
  const [detail, setDetail] = React.useState<ImportDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Which passage this visit shows, fixed once chosen, so a decision does not move on by itself.
  const [shown, setShown] = React.useState<number | undefined>(position);

  React.useEffect(() => {
    let stale = false;
    getImport(id)
      .then((answer) => {
        if (stale) return;
        setDetail(answer);
        setShown((current) => current ?? passageToShow(answer, undefined)?.position);
      })
      .catch((reason: ApiError) => !stale && setError(reason.message));
    return () => {
      stale = true;
    };
  }, [id]);

  // Requests can be answered out of order; an answer older than the one shown is dropped.
  const sent = React.useRef(0);
  const applied = React.useRef(0);
  const decide = React.useCallback<Decide>(async (run) => {
    setActionError(null);
    const order = ++sent.current;
    try {
      const answer = await run();
      if (order >= applied.current) {
        applied.current = order;
        setDetail(answer);
      }
      return true;
    } catch (e) {
      setActionError(errorText(e));
      return false;
    }
  }, []);

  const passage = detail && shown !== undefined ? passageToShow(detail, shown) : undefined;

  // A passage that stays is pending until the user has seen it: showing it is seeing it.
  const unseen = passage && passage.seenAt === null ? passage.id : null;
  React.useEffect(() => {
    if (unseen !== null) void decide(() => markPassageSeen(unseen));
  }, [unseen, decide]);

  const stays = passage ? staysInFile(passage) : false;
  const done = detail !== null && detail.passageCount > 0 && detail.pendingCount === 0;

  return (
    <div className="w-full space-y-6">
      <div className="text-left">
        <h1 className="text-2xl font-bold tracking-tight">Import</h1>
        {detail && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <FileText className="size-4" />
            <span className="font-mono text-sm break-all">{detail.rulesFile}</span>
            <span aria-hidden>·</span>
            <span className="text-sm">Rules apply to {scopeText(detail.scope).replace(/^All/, "all")}</span>
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {detail && detail.passages.length === 0 && (
        <p className="text-sm text-muted-foreground">This import has no passages yet.</p>
      )}
      {detail && detail.passages.length > 0 && <ProgressBar detail={detail} passage={passage} />}
      {done && <Finished detail={detail} compact={passage !== undefined} />}
      {detail && shown !== undefined && !passage && (
        <p className="text-sm text-muted-foreground">This import has no such passage.</p>
      )}
      {actionError && (
        <Alert variant="destructive" className="max-w-6xl">
          <TriangleAlert />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {detail && passage && (
        <div className="grid w-full max-w-6xl gap-6 lg:grid-cols-2 lg:items-start">
          <PassageCard passage={passage} decide={decide} />
          <div className="space-y-4">
            {stays && <StaysCard passage={passage} />}
            {passage.rules.map((proposed) => (
              <ProposedRuleCard key={proposed.id} proposed={proposed} importId={detail.id} decide={decide} />
            ))}
            {!stays && (
              <div className="flex justify-end">
                <WriteRuleButton passage={passage} decide={decide} label="Write another rule" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
