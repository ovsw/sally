// A rule's analytics on the Rule screen: how often it matched, on what, its
// near misses, each version's own match and false-positive counts, and the
// rule's false positives. Each match can be marked as a false positive with
// one click. Tables use the shadcn table from the data-table12 block, inside the
// Rule screen's bordered sections.
import * as React from "react";
import { ThumbsDown } from "lucide-react";

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
  type FalsePositive,
  getRuleAnalytics,
  listFalsePositives,
  type MarkedBy,
  markFalsePositive,
  type RuleAnalytics,
  type RuleCheckView,
  type RuleMatch,
  unmarkFalsePositive,
} from "@/lib/api";
import { CHECK_LABELS, formatScore, formatTime } from "@/lib/format";

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

const MARKED_BY: Record<MarkedBy, string> = {
  claude: "Claude",
  user: "you",
};

/** One click marks the match as a false positive, another takes the mark away; shows who marked it. */
function FalsePositiveButton({
  match,
  onToggle,
}: {
  match: RuleMatch;
  onToggle: (match: RuleMatch) => Promise<void>;
}) {
  const [pending, setPending] = React.useState(false);
  const marked = match.falsePositive !== null;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="xs"
        variant={marked ? "destructive" : "outline"}
        aria-pressed={marked}
        disabled={pending}
        onClick={() => {
          setPending(true);
          onToggle(match).finally(() => setPending(false));
        }}
      >
        <ThumbsDown />
        False positive
      </Button>
      {match.falsePositive && (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          Marked by {MARKED_BY[match.falsePositive.markedBy]}
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
  /** An extra last column, such as the verdict buttons on matches. */
  actions?: { title: string; cell: (row: Row) => React.ReactNode };
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Time and check</TableHead>
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
              {/* The check the match came from: a rule can take part in both. */}
              <span className="block text-xs text-foreground">{CHECK_LABELS[row.checkType]}</span>
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

function FalsePositivesTable({ falsePositives }: { falsePositives: FalsePositive[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Text</TableHead>
          <TableHead className="pr-4">Marked</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {falsePositives.map((falsePositive) => (
          <TableRow key={falsePositive.matchId}>
            <TableCell className="pl-4 align-top">
              <span className="block text-xs text-muted-foreground">
                {CHECK_LABELS[falsePositive.checkType]}
              </span>
              <p
                className="line-clamp-3 max-w-[480px] min-w-[180px] whitespace-pre-wrap"
                title={falsePositive.text}
              >
                {falsePositive.text}
              </p>
            </TableCell>
            <TableCell className="pr-4 align-top whitespace-nowrap text-muted-foreground">
              By {MARKED_BY[falsePositive.markedBy]}
              <span className="block text-xs">
                {formatTime(falsePositive.markedAt)}
                {falsePositive.versionNumber !== null && ` · version ${falsePositive.versionNumber}`}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RuleAnalyticsPanel({ id }: { id: number }) {
  const [analytics, setAnalytics] = React.useState<RuleAnalytics | null>(null);
  const [falsePositives, setFalsePositives] = React.useState<FalsePositive[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [markError, setMarkError] = React.useState<string | null>(null);

  const load = React.useCallback(
    () => Promise.all([getRuleAnalytics(id), listFalsePositives(id)]),
    [id],
  );

  React.useEffect(() => {
    let stale = false;
    load()
      .then(([loaded, marked]) => {
        if (stale) return;
        setAnalytics(loaded);
        setFalsePositives(marked);
      })
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [load]);

  // Marks can overlap; only the latest reload may replace the panel.
  const latestReload = React.useRef(0);
  const onToggle = React.useCallback(
    async (match: RuleMatch) => {
      setMarkError(null);
      try {
        if (match.falsePositive) await unmarkFalsePositive(match.matchId);
        else await markFalsePositive(match.matchId);
        const reload = ++latestReload.current;
        const [loaded, marked] = await load();
        if (reload !== latestReload.current) return;
        setAnalytics(loaded);
        setFalsePositives(marked);
      } catch (e) {
        setMarkError(e instanceof Error ? e.message : String(e));
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
    analytics.checks === 0 ? null : Math.round((analytics.matches / analytics.checks) * 100);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-3">
        <Stat
          label="Matched"
          value={analytics.matches}
          detail={
            share === null
              ? "Not checked yet"
              : `On ${share}% of ${analytics.checks} ${analytics.checks === 1 ? "check" : "checks"}`
          }
        />
        <Stat
          label="Near misses"
          value={analytics.nearMisses.length}
          detail={`Recent checks within ${formatScore(analytics.nearMissMargin)} under the cutoff`}
        />
        <Stat
          label="False positives"
          value={analytics.falsePositives}
          detail="Matches where the rule did not apply"
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
                <TableHead className="text-right">Matched</TableHead>
                <TableHead className="pr-4 text-right">False positives</TableHead>
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
                  <TableCell className="text-right tabular-nums">{version.matches}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {version.falsePositives}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Matches"
        note={
          analytics.recentMatches.length > 0
            ? "Most recent first. Mark the ones where the rule did not apply."
            : undefined
        }
      >
        {markError && (
          <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
            {markError}
          </p>
        )}
        {analytics.recentMatches.length === 0 ? (
          <Empty>This rule has not matched yet.</Empty>
        ) : (
          <ChecksTable
            rows={analytics.recentMatches}
            actions={{
              title: "",
              cell: (row) => <FalsePositiveButton match={row} onToggle={onToggle} />,
            }}
            scoreCell={(row) => formatScore(row.score)}
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
        title="False positives"
        note="Publishing a new version checks it no longer matches these"
      >
        {falsePositives.length === 0 ? (
          <Empty>No false positives.</Empty>
        ) : (
          <FalsePositivesTable falsePositives={falsePositives} />
        )}
      </Section>
    </div>
  );
}
