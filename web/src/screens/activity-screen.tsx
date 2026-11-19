// The Activity screen, built on the shadcnblocks block data-table12 (faceted
// filter data table), like the Rules screen.
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CornerUpLeft,
  RefreshCw,
} from "lucide-react";
import * as React from "react";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTablePagination,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table";
import { HeaderWithHelp } from "@/components/field-help";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ActivityCheck,
  type ActivityMatch,
  type CheckType,
  listActivity,
  type Outcome,
} from "@/lib/api";
import { formatScore, formatTime } from "@/lib/format";
import { followLink } from "@/lib/router";
import { checkTypes } from "@/screens/rules-screen";

const outcomes: {
  value: Outcome;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "attached", label: "Added to message", icon: CircleCheck },
  { value: "sent_back", label: "Sent back to Claude", icon: CornerUpLeft },
  { value: "nothing", label: "No match", icon: CircleDashed },
  { value: "skipped", label: "Not checked", icon: Ban },
  { value: "failed", label: "Failed", icon: CircleAlert },
];

/** What each result means, shown on the Result column's information mark. */
const resultHelp = (
  <>
    <p>
      <strong>Added to message:</strong> rules matched your message, so their instructions went to Claude with it.
    </p>
    <p>
      <strong>Sent back to Claude:</strong> rules matched Claude's final reply, so the reply went back to Claude
      with their instructions.
    </p>
    <p>
      <strong>No match:</strong> no rule matched; nothing was added.
    </p>
    <p>
      <strong>Not checked:</strong> skipped, as for a bare slash command, or Claude's second try after a reply was
      sent back.
    </p>
    <p>
      <strong>Failed:</strong> the check could not finish; the reason shows below it.
    </p>
  </>
);

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const meta = outcomes.find((o) => o.value === outcome);
  const Icon = meta?.icon;
  const variant =
    outcome === "failed"
      ? "destructive"
      : outcome === "attached" || outcome === "sent_back"
        ? "default"
        : outcome === "nothing"
          ? "secondary"
          : "outline";
  return (
    <Badge variant={variant} className="gap-1 whitespace-nowrap">
      {Icon && <Icon className="size-3" />}
      {meta?.label ?? outcome}
    </Badge>
  );
}

function MatchLink({ match }: { match: ActivityMatch }) {
  const label = match.name ?? "Deleted rule";
  return (
    <div>
      <span className="flex items-center gap-1.5">
        {match.name === null ? (
          <span className="text-muted-foreground italic">{label}</span>
        ) : (
          <a
            href={`/rules/${match.ruleId}`}
            onClick={followLink}
            className="font-medium hover:underline"
          >
            {label}
          </a>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatScore(match.score)}
        </span>
      </span>
      {match.condition && (
        <p
          className="line-clamp-2 max-w-[280px] text-xs whitespace-normal text-muted-foreground"
          title={match.condition}
        >
          {match.condition}
        </p>
      )}
    </div>
  );
}

const columns: ColumnDef<ActivityCheck>[] = [
  {
    accessorKey: "createdAt",
    header: "Time",
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatTime(row.original.createdAt)}
      </span>
    ),
    meta: { label: "Time" },
  },
  {
    accessorKey: "project",
    header: "Project",
    cell: ({ row }) =>
      row.original.project ? (
        <span className="block max-w-[180px] truncate" title={row.original.project}>
          {row.original.project}
        </span>
      ) : (
        <span className="text-muted-foreground">None</span>
      ),
    meta: { label: "Project" },
  },
  {
    accessorKey: "checkType",
    header: "Type",
    cell: ({ row }) => {
      const meta = checkTypes.find((t) => t.value === row.original.checkType);
      const Icon = meta?.icon;
      return (
        <span className="flex items-center gap-2 text-muted-foreground">
          {Icon && <Icon className="size-4" />}
          {meta?.label}
        </span>
      );
    },
    meta: { label: "Type" },
  },
  {
    accessorKey: "text",
    header: "Text checked",
    cell: ({ row }) => (
      <p
        className="line-clamp-2 max-w-[420px] min-w-[200px] whitespace-pre-wrap"
        title={row.original.text}
      >
        {row.original.text}
      </p>
    ),
    meta: { label: "Text checked" },
  },
  {
    accessorKey: "outcome",
    header: () => <HeaderWithHelp title="Result">{resultHelp}</HeaderWithHelp>,
    cell: ({ row }) => (
      <div className="space-y-1">
        <OutcomeBadge outcome={row.original.outcome} />
        {row.original.error && (
          <p className="max-w-[220px] text-xs whitespace-normal text-destructive">
            {row.original.error}
          </p>
        )}
      </div>
    ),
    meta: { label: "Result" },
  },
  {
    id: "attached",
    header: () => (
      <HeaderWithHelp title="Matched rules">
        <p>The rules that matched this text, each with its score and the condition that scored highest.</p>
        <p>
          A score from 0 to 1 is how likely the rule's condition holds for the text. A rule matches when a score
          reaches the cutoff set in Settings.
        </p>
      </HeaderWithHelp>
    ),
    cell: ({ row }) => {
      if (row.original.matches.length === 0) {
        return <span className="text-muted-foreground">None</span>;
      }
      return (
        <div className="space-y-1">
          {row.original.matches.map((match) => (
            <MatchLink key={match.ruleId} match={match} />
          ))}
        </div>
      );
    },
    meta: { label: "Matched rules" },
  },
];

const values = (filters: ColumnFiltersState, id: string) =>
  filters.find((f) => f.id === id)?.value as string[] | undefined;

export function ActivityScreen() {
  const [checks, setChecks] = React.useState<ActivityCheck[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const { table, columnFilters } = useDataTable({
    data: checks,
    columns: columns as ColumnDef<ActivityCheck, unknown>[],
    getRowId: (row) => String(row.id),
    enableRowSelection: false,
    manualFiltering: true,
  });

  React.useEffect(() => {
    let stale = false;
    listActivity({
      outcomes: values(columnFilters, "outcome") as Outcome[] | undefined,
      checkType: values(columnFilters, "checkType") as CheckType[] | undefined,
    })
      .then((next) => {
        if (stale) return;
        setChecks(next);
        setError(null);
      })
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !stale && setLoaded(true));
    return () => {
      stale = true;
    };
  }, [columnFilters, attempt]);

  return (
    <div className="w-full">
      <div className="mb-4 text-left">
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        <p className="mt-2 text-muted-foreground">
          The most recent checks, newest first: the text checked, what
          happened, and which rules matched.
        </p>
      </div>
      <DataTableToolbar table={table}>
        <DataTableFacetedFilter
          column={table.getColumn("outcome")}
          title="Result"
          options={outcomes}
        />
        <DataTableFacetedFilter
          column={table.getColumn("checkType")}
          title="Type"
          options={checkTypes}
        />
        <div className="ml-auto">
          <Button variant="outline" size="sm" className="h-8" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw />
            Refresh
          </Button>
        </div>
      </DataTableToolbar>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <DataTable
        table={table}
        emptyMessage={
          !loaded
            ? "Loading..."
            : columnFilters.length > 0
              ? "No checks match."
              : "No checks yet. They appear here as you use Claude Code."
        }
      />
      <DataTablePagination table={table} />
    </div>
  );
}
