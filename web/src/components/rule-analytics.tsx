// A rule's analytics on the Rule screen: how often it fired, on what, its
// near misses, each version's own firing and wrong-match counts, and the
// rule's saved cases. Each firing can be marked wrong or correct with one
// click. Tables use the shadcn table from the data-table12 block, inside the
// Rule screen's bordered sections.
import * as React from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  flagFiring,
  getRuleAnalytics,
  listSavedCases,
  type RaisedBy,
  type RuleAnalytics,
  type RuleCheckView,
  type RuleFiring,
  type SavedCase,
  type Verdict,
} from "@/lib/api";
import { formatScore, formatTime } from "@/lib/format";

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-medium">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: React.ReactNode; detail?: string }) {
  return (
    <div className="space-y-1 rounded-md border px-4 py-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>
  );
}

const RAISED_BY: Record<RaisedBy, string> = {
  claude: "Claude",
  user: "you",
  automatic: "the automatic check",
};

/** One click marks the firing wrong, one marks it correct; shows who flagged it. */
function FlagButtons({
  firing,
  onFlag,
}: {
  firing: RuleFiring;
  onFlag: (firing: RuleFiring, verdict: Verdict) => Promise<void>;
}) {
  const [pending, setPending] = React.useState(false);
  const mark = (verdict: Verdict) => {
    setPending(true);
    onFlag(firing, verdict).finally(() => setPending(false));
  };
  const verdict = firing.flag?.verdict;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1">
        <Button
          size="xs"
          variant={verdict === "wrong" ? "destructive" : "outline"}
          aria-pressed={verdict === "wrong"}
          disabled={pending}
          onClick={() => mark("wrong")}
        >
          <ThumbsDown />
          Wrong
        </Button>
        <Button
          size="xs"
          variant={verdict === "correct" ? "default" : "outline"}
          aria-pressed={verdict === "correct"}
          disabled={pending}
          onClick={() => mark("correct")}
        >
          <ThumbsUp />
          Correct
        </Button>
      </div>
      {firing.flag && (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          Flagged by {RAISED_BY[firing.flag.raisedBy]}
        </span>
      )}
    </div>
  );
}

function ChecksTable<Row extends RuleCheckView>({
  rows,
  scoreCell,
  actions,
}: {
  rows: Row[];
  scoreCell: (row: Row) => React.ReactNode;
  /** An extra last column, such as the verdict buttons on firings. */
  actions?: { title: string; cell: (row: Row) => React.ReactNode };
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Time</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Text checked</TableHead>
          <TableHead>Highest condition</TableHead>
          <TableHead className={actions ? "text-right" : "pr-4 text-right"}>Score</TableHead>
          {actions && <TableHead className="pr-4">{actions.title}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.checkId}>
            <TableCell className="pl-4 align-top whitespace-nowrap text-muted-foreground">
              {formatTime(row.createdAt)}
              {row.project && (
                <span className="block max-w-[160px] truncate text-xs" title={row.project}>
                  {row.project}
                </span>
              )}
            </TableCell>
            <TableCell className="align-top text-muted-foreground">
              {row.versionNumber ?? "–"}
            </TableCell>
            <TableCell className="align-top">
              <p
                className="line-clamp-3 max-w-[380px] min-w-[180px] whitespace-pre-wrap"
                title={row.text}
              >
                {row.text}
              </p>
            </TableCell>
            <TableCell className="align-top">
              <p className="max-w-[260px] min-w-[140px] whitespace-normal text-muted-foreground">
                {row.condition ?? "–"}
              </p>
            </TableCell>
            <TableCell
              className={`text-right align-top tabular-nums ${actions ? "" : "pr-4"}`}
            >
              {scoreCell(row)}
            </TableCell>
            {actions && <TableCell className="pr-4 align-top">{actions.cell(row)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SavedCasesTable({ cases }: { cases: SavedCase[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Expected</TableHead>
          <TableHead>Text</TableHead>
          <TableHead className="pr-4">From</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cases.map((savedCase) => (
          <TableRow key={savedCase.id}>
            <TableCell className="pl-4 align-top">
              <Badge
                variant={savedCase.expected === "should_fire" ? "secondary" : "outline"}
                className="whitespace-nowrap"
              >
                {savedCase.expected === "should_fire" ? "Should fire" : "Should not fire"}
              </Badge>
            </TableCell>
            <TableCell className="align-top">
              <p
                className="line-clamp-3 max-w-[480px] min-w-[180px] whitespace-pre-wrap"
                title={savedCase.text}
              >
                {savedCase.text}
              </p>
            </TableCell>
            <TableCell className="pr-4 align-top whitespace-nowrap text-muted-foreground">
              {savedCase.source ? (
                <>
                  {savedCase.source.verdict === "wrong" ? "Wrong match" : "Correct"}, flagged by{" "}
                  {RAISED_BY[savedCase.source.raisedBy]}
                  <span className="block text-xs">
                    {formatTime(savedCase.createdAt)}
                    {savedCase.source.versionNumber !== null &&
                      ` · version ${savedCase.source.versionNumber}`}
                  </span>
                </>
              ) : (
                formatTime(savedCase.createdAt)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RuleAnalyticsPanel({ id }: { id: number }) {
  const [analytics, setAnalytics] = React.useState<RuleAnalytics | null>(null);
  const [cases, setCases] = React.useState<SavedCase[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [flagError, setFlagError] = React.useState<string | null>(null);

  const load = React.useCallback(
    () => Promise.all([getRuleAnalytics(id), listSavedCases(id)]),
    [id],
  );

  React.useEffect(() => {
    let stale = false;
    load()
      .then(([loaded, savedCases]) => {
        if (stale) return;
        setAnalytics(loaded);
        setCases(savedCases);
      })
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [load]);

  // Marks can overlap; only the latest reload may replace the panel.
  const latestReload = React.useRef(0);
  const onFlag = React.useCallback(
    async (firing: RuleFiring, verdict: Verdict) => {
      setFlagError(null);
      try {
        await flagFiring(firing.firingId, verdict);
        const reload = ++latestReload.current;
        const [loaded, savedCases] = await load();
        if (reload !== latestReload.current) return;
        setAnalytics(loaded);
        setCases(savedCases);
      } catch (e) {
        setFlagError(e instanceof Error ? e.message : String(e));
      }
    },
    [load],
  );

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!analytics) {
    return <p className="text-sm text-muted-foreground">Loading analytics...</p>;
  }

  const share =
    analytics.checks === 0 ? null : Math.round((analytics.firings / analytics.checks) * 100);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Fired"
          value={analytics.firings}
          detail={
            share === null
              ? "Not checked yet"
              : `On ${share}% of ${analytics.checks} ${analytics.checks === 1 ? "check" : "checks"}`
          }
        />
        <Stat
          label="Cut by the cap"
          value={analytics.dropped}
          detail="Fired, but stronger rules filled the cap"
        />
        <Stat
          label="Near misses"
          value={analytics.nearMisses.length}
          detail={`Recent checks within ${formatScore(analytics.nearMissMargin)} under the cutoff`}
        />
        <Stat
          label="Wrong matches"
          value={analytics.wrongMatches}
          detail="Firings flagged as not applying"
        />
      </div>

      <Section title="Versions" note="Each published version's own record">
        {analytics.versions.length === 0 ? (
          <Empty>No published versions yet.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Version</TableHead>
                <TableHead>Published</TableHead>
                <TableHead className="text-right">Checks</TableHead>
                <TableHead className="text-right">Fired</TableHead>
                <TableHead className="pr-4 text-right">Wrong matches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.versions.map((version) => (
                <TableRow key={version.number}>
                  <TableCell className="pl-4">Version {version.number}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTime(version.publishedAt)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{version.checks}</TableCell>
                  <TableCell className="text-right tabular-nums">{version.firings}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {version.wrongMatches}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Firings"
        note={
          analytics.recentFirings.length > 0
            ? "Most recent first. Mark each one wrong or correct to keep it as a saved case."
            : undefined
        }
      >
        {flagError && (
          <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
            {flagError}
          </p>
        )}
        {analytics.recentFirings.length === 0 ? (
          <Empty>This rule has not fired yet.</Empty>
        ) : (
          <ChecksTable
            rows={analytics.recentFirings}
            actions={{
              title: "Verdict",
              cell: (row) => <FlagButtons firing={row} onFlag={onFlag} />,
            }}
            scoreCell={(row) => (
              <span className="flex flex-col items-end gap-1">
                {formatScore(row.score)}
                {row.dropped && (
                  <Badge variant="outline" className="whitespace-nowrap">
                    Cut by the cap
                  </Badge>
                )}
              </span>
            )}
          />
        )}
      </Section>

      <Section
        title="Near misses"
        note="Checks where the rule scored just under the cutoff"
      >
        {analytics.nearMisses.length === 0 ? (
          <Empty>No near misses.</Empty>
        ) : (
          <ChecksTable
            rows={analytics.nearMisses}
            scoreCell={(row) => (
              <span>
                {formatScore(row.score)}
                <span className="block text-xs text-muted-foreground">
                  cutoff {formatScore(row.cutoff)}
                </span>
              </span>
            )}
          />
        )}
      </Section>

      <Section
        title="Saved cases"
        note="Every flagged firing, kept with the outcome it should have"
      >
        {cases.length === 0 ? (
          <Empty>No saved cases yet. Mark a firing wrong or correct to keep one.</Empty>
        ) : (
          <SavedCasesTable cases={cases} />
        )}
      </Section>
    </div>
  );
}
