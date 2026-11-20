// Before a draft goes live: whether it still matches the rule's past false
// positives. Built on the shadcn alert dialog the Rule screen already uses.
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
import type { FalsePositiveResult, RescoreResult } from "@/lib/api";
import { CHECK_LABELS, formatScore } from "@/lib/format";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ResultRow({ result }: { result: FalsePositiveResult }) {
  const check = CHECK_LABELS[result.falsePositive.checkType];
  const closest = result.scores.reduce<FalsePositiveResult["scores"][number] | null>(
    (top, score) => (top === null || score.score > top.score ? score : top),
    null,
  );
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        {result.passed ? (
          <Badge variant="secondary">
            <Check />
            Fixed
          </Badge>
        ) : (
          <Badge variant="destructive">
            <X />
            Still matches
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {check} ·{" "}
          {result.best === null
            ? `no condition is on for ${result.falsePositive.checkType === "message" ? "user messages" : "agent replies"}`
            : `scores ${formatScore(result.best)}, matches at ${formatScore(result.cutoff)}`}
        </span>
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap" title={result.falsePositive.text}>
        {result.falsePositive.text}
      </p>
      {closest && (
        <p className="text-xs text-muted-foreground">
          Closest condition: <span className="text-foreground">{closest.condition}</span>
        </p>
      )}
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
  result: Exclude<RescoreResult, { status: "no_false_positives" }> | null;
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
                ? result.results.length === 1
                  ? "The new version no longer matches its false positive"
                  : `The new version matches none of its ${result.results.length} false positives`
                : `The new version still matches ${result.failed} of ${plural(result.results.length, "false positive")}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {result.results.length === 1 ? "This text once matched" : "These texts once matched"}{" "}
              the rule where it did not apply. Each one was scored against the new version.
            </AlertDialogDescription>
          </AlertDialogHeader>
        )}
        {result?.status === "failed" && (
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-destructive" />
              Could not check the false positives
            </AlertDialogTitle>
            <AlertDialogDescription>
              Jev could not score the new version against this rule's{" "}
              {plural(result.count, "false positive")} ({result.error}). You can still publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
        )}
        {result?.status === "scored" && (
          <ul className="max-h-[50vh] divide-y overflow-y-auto">
            {/* Failures first: they are what the user needs to look at. */}
            {[...result.results]
              .sort((a, b) => Number(a.passed) - Number(b.passed))
              .map((result) => (
                <ResultRow key={result.falsePositive.matchId} result={result} />
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
