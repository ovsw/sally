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
  { value: "attached", label: "Attached", icon: CircleCheck },
  { value: "sent_back", label: "Sent back", icon: CornerUpLeft },
  { value: "nothing", label: "Nothing", icon: CircleDashed },
  { value: "skipped", label: "Skipped", icon: Ban },
  { value: "failed", label: "Failed", icon: CircleAlert },
];

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
    header: "Check",
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
    meta: { label: "Check" },
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
    header: "Outcome",
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
    meta: { label: "Outcome" },
  },
  {
    id: "attached",
    header: "Attached",
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
    meta: { label: "Attached" },
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
          The most recent checks, newest first: what was checked and what the
          engine attached or sent back.
        </p>
      </div>
      <DataTableToolbar table={table}>
        <DataTableFacetedFilter
          column={table.getColumn("outcome")}
          title="Outcome"
          options={outcomes}
        />
        <DataTableFacetedFilter
          column={table.getColumn("checkType")}
          title="Check"
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
