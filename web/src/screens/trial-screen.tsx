// The Trial screen: type a text and some conditions, and see how Jev scores
// each condition against the text. A rule can fill the conditions; editing
// them never changes the rule. Nothing about a trial is recorded. Laid out as
// the Settings screen is (shadcnblocks form-layouts-7), with the results beside
// the form on a wide screen.
import { Check, FlaskConical, Loader2, Plus, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { cn } from "cn";

import { LabelWithHelp } from "@/components/field-help";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type CheckType, getRule, listRules, type RuleSummary, runTrial, type TrialResult } from "@/lib/api";
import { formatScore } from "@/lib/format";

const CHECK_NAMES: Record<CheckType, string> = { message: "Message", reply: "Reply" };

const help = {
  text: "The text to score, as if it were your message or Claude's reply. It goes to Jev as a real check sends it: email addresses masked, and the middle cut if it is too long.",
  checkType:
    "Whether the text stands for your message or Claude's reply. It picks the cutoff the scores are compared with, and which of a rule's conditions it fills in.",
  conditions:
    "Short, concrete statements that are true or false of the text. Each is scored on its own; a rule with these conditions would match when any one reaches the cutoff.",
  rule: "Fills the conditions with a rule's conditions that are on for Message or Reply, worded as in its draft if it has one, otherwise as published. Editing them here never changes the rule. The rule's instruction shows below for context; Jev never sees it.",
};

/**
 * What a rule gives a trial of this check type: its conditions on for that
 * type, and its instruction to show beside them. Both come from its draft if
 * it has one, otherwise its published version.
 */
async function ruleText(ruleId: number, checkType: CheckType): Promise<{ conditions: string[]; instruction: string }> {
  const rule = await getRule(ruleId);
  const version = rule.draft ?? rule.live;
  return {
    conditions: (version?.conditions ?? []).filter((c) => c[checkType]).map((c) => c.text),
    instruction: version?.instruction ?? "",
  };
}

type RunState = { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string };

export function TrialScreen() {
  const [text, setText] = React.useState("");
  const [checkType, setCheckType] = React.useState<CheckType>("message");
  const [conditions, setConditions] = React.useState<string[]>([""]);
  const [rules, setRules] = React.useState<RuleSummary[] | null>(null);
  const [rulesError, setRulesError] = React.useState<string | null>(null);
  const [ruleId, setRuleId] = React.useState<string>("");
  const [fillNote, setFillNote] = React.useState<string | null>(null);
  // The chosen rule's instruction, shown for context only: Jev never sees it.
  const [instruction, setInstruction] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<RunState>({ kind: "idle" });
  // The last run's answer stays until the next run, whatever is edited meanwhile.
  const [result, setResult] = React.useState<TrialResult | null>(null);

  React.useEffect(() => {
    listRules({})
      .then(setRules)
      .catch((error: unknown) => setRulesError(error instanceof Error ? error.message : String(error)));
  }, []);

  const chooseRule = async (id: string) => {
    setRuleId(id);
    setFillNote(null);
    const rule = rules?.find((r) => String(r.id) === id);
    setInstruction(null);
    try {
      const { conditions: filled, instruction } = await ruleText(Number(id), checkType);
      setConditions(filled.length > 0 ? filled : [""]);
      setInstruction(instruction);
      if (filled.length === 0) {
        setFillNote(`${rule?.name ?? "This rule"} has no conditions on for ${CHECK_NAMES[checkType]}.`);
      }
    } catch (error) {
      setFillNote(`Could not load the rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const written = conditions.filter((c) => c.trim().length > 0);
  const canRun = text.trim().length > 0 && written.length > 0 && run.kind !== "running";

  const score = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canRun) return;
    setRun({ kind: "running" });
    try {
      setResult(await runTrial({ text, checkType, conditions }));
      setRun({ kind: "idle" });
    } catch (error) {
      setRun({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="@container w-full">
      <div className="mb-6 text-left">
        <h1 className="text-2xl font-bold tracking-tight">Trial</h1>
        <p className="mt-2 text-muted-foreground">
          Score a text against some conditions with Jev. Nothing is recorded, and no rule changes.
        </p>
      </div>
      <div className="grid grid-cols-1 items-start gap-8 @4xl:grid-cols-2">
        <form className="w-full max-w-2xl" onSubmit={(e) => void score(e)} noValidate>
          <FieldGroup className="gap-6">
            <Field>
              <LabelWithHelp htmlFor="trial-rule" label="Rule">
                {help.rule}
              </LabelWithHelp>
              <Select value={ruleId} onValueChange={(id) => void chooseRule(id)} disabled={!rules || rules.length === 0}>
                <SelectTrigger id="trial-rule" className="w-full bg-background">
                  <SelectValue placeholder={rules && rules.length > 0 ? `e.g. ${rules[0]!.name}` : "No rules yet"} />
                </SelectTrigger>
                <SelectContent>
                  {rules?.map((rule) => (
                    <SelectItem key={rule.id} value={String(rule.id)}>
                      {rule.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {rulesError && <p className="text-sm text-destructive">Could not load the rules: {rulesError}</p>}
              {fillNote && <p className="text-sm text-muted-foreground">{fillNote}</p>}
              {instruction !== null && (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <p className="text-xs font-medium text-muted-foreground">Instruction · for context, not scored</p>
                  <p className="mt-1 break-words whitespace-pre-wrap">
                    {instruction.trim() || <span className="text-muted-foreground">This rule has no instruction yet.</span>}
                  </p>
                </div>
              )}
            </Field>

            <Field>
              <LabelWithHelp id="trial-check-type" label="Check type">
                {help.checkType}
              </LabelWithHelp>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                aria-labelledby="trial-check-type"
                value={checkType}
                // A single toggle group answers "" when its pressed item is pressed again; the switch always has a side.
                onValueChange={(value) => value && setCheckType(value as CheckType)}
              >
                <ToggleGroupItem value="message" className="px-4">
                  Message
                </ToggleGroupItem>
                <ToggleGroupItem value="reply" className="px-4">
                  Reply
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <Field>
              <LabelWithHelp htmlFor="trial-text" label="Text">
                {help.text}
              </LabelWithHelp>
              <Textarea
                id="trial-text"
                className="min-h-40 bg-background"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  checkType === "message"
                    ? "e.g. Can you make the header logo a bit bigger?"
                    : "e.g. Done: the logo is now 20% bigger. Open the settings page and click Save to see it."
                }
              />
            </Field>

            <ConditionFields conditions={conditions} onChange={setConditions} />

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canRun}>
                {run.kind === "running" ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                Score
              </Button>
              {run.kind === "error" && (
                <p role="alert" className="text-sm text-destructive">
                  {run.message}
                </p>
              )}
            </div>
          </FieldGroup>
        </form>

        <section aria-label="Scores" className="w-full max-w-2xl">
          <Results result={result} />
        </section>
      </div>
    </div>
  );
}

function ConditionFields({ conditions, onChange }: { conditions: string[]; onChange: (next: string[]) => void }) {
  const labelId = React.useId();
  return (
    <Field aria-labelledby={labelId}>
      <LabelWithHelp id={labelId} label="Conditions">
        {help.conditions}
      </LabelWithHelp>
      <div className="space-y-2">
        {conditions.map((condition, index) => (
          <div key={index} className="flex items-start gap-2">
            <Input
              className="bg-background"
              aria-label={`Condition ${index + 1}`}
              value={condition}
              onChange={(e) => onChange(conditions.map((c, i) => (i === index ? e.target.value : c)))}
              placeholder="e.g. The message asks for a visual change."
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={`Remove condition ${index + 1}`}
              disabled={conditions.length === 1}
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...conditions, ""])}>
          <Plus />
          Add condition
        </Button>
      </div>
    </Field>
  );
}

function Results({ result }: { result: TrialResult | null }) {
  if (!result) {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Scores show here after you score a text.
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Jev could not score the conditions</AlertTitle>
        <AlertDescription>{result.error === "missing API key" ? "No Jev API key is set." : result.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        {result.matched ? (
          <Badge>
            <Check />
            Would match
          </Badge>
        ) : (
          <Badge variant="secondary">
            <X />
            Would not match
          </Badge>
        )}
        <span className="text-sm text-muted-foreground">Cutoff {formatScore(result.cutoff)}</span>
      </div>
      <ul className="divide-y">
        {result.scores.map((row, index) => {
          const reached = row.score >= result.cutoff;
          return (
            <li key={index} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm break-words">{row.condition}</p>
                <span className={cn("shrink-0 font-mono text-sm tabular-nums", reached ? "font-semibold" : "text-muted-foreground")}>
                  {formatScore(row.score)}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-muted" aria-hidden>
                <div
                  className={cn("absolute inset-y-0 left-0 rounded-full", reached ? "bg-primary" : "bg-muted-foreground/40")}
                  style={{ width: `${row.score * 100}%` }}
                />
                <div className="absolute -inset-y-1 w-px bg-foreground/60" style={{ left: `${result.cutoff * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {result.cut && (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          The text was too long for Jev, so its middle was cut, as a real check would.
        </p>
      )}
    </div>
  );
}
