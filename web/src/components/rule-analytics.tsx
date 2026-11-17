// A rule's analytics on the Rule screen: how often it fired, on what, its
// near misses, and each version's own firing count. Tables use the shadcn
// table from the data-table12 block, inside the Rule screen's bordered
// sections.
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRuleAnalytics, type RuleAnalytics, type RuleCheckView } from "@/lib/api";
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

function ChecksTable({
  rows,
  scoreCell,
}: {
  rows: RuleCheckView[];
  scoreCell: (row: RuleCheckView) => React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Time</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Text checked</TableHead>
          <TableHead>Highest condition</TableHead>
          <TableHead className="pr-4 text-right">Score</TableHead>
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
            <TableCell className="pr-4 text-right align-top tabular-nums">
              {scoreCell(row)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RuleAnalyticsPanel({ id }: { id: number }) {
  const [analytics, setAnalytics] = React.useState<RuleAnalytics | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stale = false;
    getRuleAnalytics(id)
      .then((loaded) => !stale && setAnalytics(loaded))
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [id]);

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
  const dropped = new Map(analytics.recentFirings.map((f) => [f.checkId, f.dropped]));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                <TableHead className="pr-4 text-right">Fired</TableHead>
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
                  <TableCell className="pr-4 text-right tabular-nums">{version.firings}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Firings"
        note={analytics.recentFirings.length > 0 ? "Most recent first" : undefined}
      >
        {analytics.recentFirings.length === 0 ? (
          <Empty>This rule has not fired yet.</Empty>
        ) : (
          <ChecksTable
            rows={analytics.recentFirings}
            scoreCell={(row) => (
              <span className="flex flex-col items-end gap-1">
                {formatScore(row.score)}
                {dropped.get(row.checkId) && (
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
    </div>
  );
}
