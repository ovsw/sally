// The Import screen: one passage of a rules file at a time, with what the
// import proposes for it and why, and a publish action for each proposed
// rule. Each card follows the shadcnblocks block card-standard-1 (shadcn Card
// with header, content and footer).
import { Check, FileText, Loader2, TriangleAlert, Upload } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ApiError,
  getImport,
  type ImportDetail,
  type Passage,
  type PassageVerdict,
  type ProposedRule,
  publish,
  type Scope,
} from "@/lib/api";
import { followLink } from "@/lib/router";

const VERDICTS: Record<PassageVerdict, string> = {
  becomes_rule: "Becomes a rule",
  always_rule: "Stays as an always-rule",
  too_vague: "Stays, too vague to match on",
};

const scopeText = (scope: Scope) => (scope.kind === "all" ? "All projects" : scope.projects.join(", "));

/** The passage to show: the one asked for, else the first still pending, else the first. */
function passageToShow(detail: ImportDetail, position: number | undefined): Passage | undefined {
  if (position !== undefined) return detail.passages.find((p) => p.position === position);
  return detail.passages.find((p) => p.pending) ?? detail.passages[0];
}

function ProposedRuleCard({ proposed, onPublished }: { proposed: ProposedRule; onPublished: () => void }) {
  const [state, setState] = React.useState<{ kind: "idle" | "publishing" } | { kind: "error"; message: string }>({
    kind: "idle",
  });
  const rule = proposed.rule;
  if (!rule) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-muted-foreground">Skipped</CardTitle>
          <CardDescription>This proposed rule was skipped, so it never went live.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  // The proposal as it stands: the draft while there is one, else the live version.
  const version = rule.draft ?? rule.live!;
  const published = proposed.decision === "published";

  async function onPublish() {
    setState({ kind: "publishing" });
    try {
      await publish(rule!.id);
      setState({ kind: "idle" });
      onPublished();
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{version.name}</CardTitle>
          {published ? (
            <Badge className="gap-1">
              <Check className="size-3" />
              Live
            </Badge>
          ) : (
            <Badge variant="secondary">Draft</Badge>
          )}
        </div>
        <CardDescription>
          {version.checkType === "message" ? "Message check" : "Reply check"} · {scopeText(version.scope)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">When</h3>
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
        {state.kind === "error" && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex justify-between gap-2">
        <a
          href={`/rules/${rule.id}`}
          onClick={followLink}
          className="text-sm text-muted-foreground hover:underline"
        >
          Open the rule
        </a>
        {published ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check className="size-4" />
            Live from the next check
          </span>
        ) : (
          <Button onClick={onPublish} disabled={state.kind === "publishing"}>
            {state.kind === "publishing" ? <Loader2 className="animate-spin" /> : <Upload />}
            Publish
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function PassageCard({ passage, total }: { passage: Passage; total: number }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardDescription>
          Passage {passage.position} of {total}
        </CardDescription>
        <CardTitle>{VERDICTS[passage.verdict]}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">In the rules file</h3>
          <pre className="rounded-md border bg-muted/50 p-3 font-mono text-sm whitespace-pre-wrap">{passage.text}</pre>
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Why</h3>
          <p className="text-sm text-muted-foreground">{passage.reason}</p>
        </div>
        {passage.similarRule && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>{passage.similarRule}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function ImportScreen({ id, position }: { id: number; position?: number }) {
  const [detail, setDetail] = React.useState<ImportDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Which passage this visit shows, fixed once chosen, so publishing does not move on by itself.
  const [shown, setShown] = React.useState<number | undefined>(position);

  const load = React.useCallback(() => {
    getImport(id)
      .then((answer) => {
        setDetail(answer);
        setShown((current) => current ?? passageToShow(answer, undefined)?.position);
      })
      .catch((reason: ApiError) => setError(reason.message));
  }, [id]);
  React.useEffect(load, [load]);

  const passage = detail && shown !== undefined ? passageToShow(detail, shown) : undefined;

  return (
    <div className="w-full">
      <div className="mb-6 text-left">
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
      {detail && !passage && (
        <p className="text-sm text-muted-foreground">
          {detail.passages.length === 0 ? "This import has no passages yet." : "This import has no such passage."}
        </p>
      )}
      {detail && passage && (
        <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-2 lg:items-start">
          <PassageCard passage={passage} total={detail.passageCount} />
          <div className="space-y-4">
            {passage.rules.length > 0 ? (
              passage.rules.map((proposed) => (
                <ProposedRuleCard key={proposed.id} proposed={proposed} onPublished={load} />
              ))
            ) : (
              <Card className="w-full">
                <CardHeader>
                  <CardTitle>Stays in the rules file</CardTitle>
                  <CardDescription>
                    Claude Code keeps reading this passage from the rules file; nothing goes into Sally.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
