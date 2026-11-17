// Before a draft goes live: how its conditions fare against the rule's saved
// cases. Built on the shadcn alert dialog the Rule screen already uses.
import { Check, TriangleAlert, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import type { CaseResult, RescoreResult } from "@/lib/api";
import { formatScore } from "@/lib/format";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function CaseRow({ result, cutoff }: { result: CaseResult; cutoff: number }) {
  const shouldFire = result.case.expected === "should_fire";
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        {result.passed ? (
          <Badge variant="secondary">
            <Check />
            Pass
          </Badge>
        ) : (
          <Badge variant="destructive">
            <X />
            Fail
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {shouldFire ? "Should fire" : "Should not fire"} ·{" "}
          {result.fired ? "fires" : "does not fire"} at {formatScore(result.best)} (cutoff{" "}
          {formatScore(cutoff)})
        </span>
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap" title={result.case.text}>
        {result.case.text}
      </p>
    </li>
  );
}

/**
 * Shows the re-score of a draft and lets the user publish anyway or go back to
 * the draft. `result` is null when the dialog is closed.
 */
export function RescoreDialog({
  result,
  onPublish,
  onBack,
}: {
  result: Exclude<RescoreResult, { status: "no_cases" }> | null;
  onPublish: () => void;
  onBack: () => void;
}) {
  const allPass = result?.status === "scored" && result.failed === 0;
  return (
    <AlertDialog open={result !== null} onOpenChange={(open) => !open && onBack()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-xl">
        {result?.status === "scored" && (
          <AlertDialogHeader>
            <AlertDialogTitle>
              {allPass
                ? `All ${plural(result.cases.length, "saved case")} pass`
                : `${result.failed} of ${plural(result.cases.length, "saved case")} fail`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Jev scored the draft's conditions against each case this rule has kept. A case passes
              when the draft fires on it as expected.
            </AlertDialogDescription>
          </AlertDialogHeader>
        )}
        {result?.status === "failed" && (
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-destructive" />
              Could not check the saved cases
            </AlertDialogTitle>
            <AlertDialogDescription>
              Jev could not score the draft against this rule's{" "}
              {plural(result.caseCount, "saved case")} ({result.error}). You can still publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
        )}
        {result?.status === "scored" && (
          <ul className="max-h-[50vh] divide-y overflow-y-auto">
            {/* Failures first: they are what the user needs to look at. */}
            {[...result.cases]
              .sort((a, b) => Number(a.passed) - Number(b.passed))
              .map((caseResult) => (
                <CaseRow key={caseResult.case.id} result={caseResult} cutoff={result.cutoff} />
              ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Back to draft</AlertDialogCancel>
          <AlertDialogAction onClick={onPublish}>
            {allPass ? "Publish" : "Publish anyway"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
