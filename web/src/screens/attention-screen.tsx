// The Needs attention screen, built on the shadcnblocks block data-table12
// (faceted filter data table), like the Rules and Activity screens.
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import {
  Activity,
  Check,
  CircleSlash,
  Flag,
  Gauge,
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
  type AttentionEntry,
  type AttentionKind,
  type CheckType,
  clearAttentionReason,
  listAttention,
} from "@/lib/api";
import { followLink, navigate } from "@/lib/router";
import { checkTypes } from "@/screens/rules-screen";

const kinds: {
  value: AttentionKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "wrong_matches", label: "Wrong matches", icon: Flag },
  { value: "matches_often", label: "Matches often", icon: Activity },
  { value: "weak_matches", label: "Weak matches", icon: Gauge },
  { value: "never_matches", label: "Never matches", icon: CircleSlash },
];

function ReasonBadge({ kind }: { kind: AttentionKind }) {
  const meta = kinds.find((k) => k.value === kind);
  const Icon = meta?.icon;
  return (
    <Badge
      variant={kind === "wrong_matches" ? "destructive" : "secondary"}
      className="gap-1 whitespace-nowrap"
    >
      {Icon && <Icon className="size-3" />}
      {meta?.label ?? kind}
    </Badge>
  );
}

/** Told which reason of which rule was cleared, so the list can drop it. */
const ClearedContext = React.createContext<
  (ruleId: number, kind: AttentionKind) => void
>(() => undefined);

/**
 * The list without one reason of one rule; the rule goes with its last
 * reason. Each clear removes only its own reason, so answers that arrive out
 * of order cannot bring a cleared reason back.
 */
const withoutReason = (
  entries: AttentionEntry[],
  ruleId: number,
  kind: AttentionKind,
): AttentionEntry[] =>
  entries
    .map((entry) =>
      entry.ruleId === ruleId
        ? { ...entry, reasons: entry.reasons.filter((r) => r.kind !== kind) }
        : entry,
    )
    .filter((entry) => entry.reasons.length > 0);

/**
 * Clears one reason for one rule's live version: the user looked and judged
 * it fine. Wrong matches get no such button; they go when the rule is fixed.
 */
function LooksFine({
  ruleId,
  versionNumber,
  kind,
}: {
  ruleId: number;
  versionNumber: number;
  kind: AttentionKind;
}) {
  const onCleared = React.useContext(ClearedContext);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const label =
    kinds.find((k) => k.value === kind)?.label.toLowerCase() ?? kind;

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        className="text-muted-foreground"
        aria-label={`Looks fine: ${label}`}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          setBusy(true);
          setError(null);
          clearAttentionReason(ruleId, kind, versionNumber)
            .then(() => onCleared(ruleId, kind))
            .catch((e: unknown) => {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            });
        }}
      >
        <Check />
        Looks fine
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-destructive">
          Could not clear it: {error}
        </p>
      )}
    </>
  );
}

const columns: ColumnDef<AttentionEntry>[] = [
  {
    accessorKey: "name",
    header: "Rule",
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <a
          href={`/rules/${row.original.ruleId}`}
          onClick={(event) => {
            event.stopPropagation();
            followLink(event);
          }}
          className="block max-w-[320px] truncate font-medium hover:underline"
        >
          {row.original.name}
        </a>
        <span className="text-xs text-muted-foreground">
          Version {row.original.versionNumber}
        </span>
      </div>
    ),
    enableHiding: false,
    meta: { label: "Rule" },
  },
  {
    // The checks the rule takes part in; a rule in both is listed under either.
    id: "checkType",
    accessorFn: (row) => row.checkTypes,
    header: "Type",
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        {checkTypes
          .filter((t) => row.original.checkTypes.includes(t.value as CheckType))
          .map(({ value, label, icon: Icon }) => (
            <span key={value} className="flex items-center gap-2">
              <Icon className="size-4" />
              {label}
            </span>
          ))}
      </span>
    ),
    filterFn: (row, _id, value: string[]) => value.some((type) => row.original.checkTypes.includes(type as CheckType)),
    meta: { label: "Type" },
  },
  {
    id: "reason",
    accessorFn: (entry) => entry.reasons.map((r) => r.kind),
    header: "Why it is listed",
    cell: ({ row }) => (
      <ul className="space-y-2">
        {row.original.reasons.map((reason) => (
          <li key={reason.kind} className="flex flex-wrap items-start gap-2">
            <ReasonBadge kind={reason.kind} />
            <span className="min-w-[200px] flex-1 whitespace-normal">
              {reason.summary}
            </span>
            {reason.kind !== "wrong_matches" && (
              <LooksFine
                ruleId={row.original.ruleId}
                versionNumber={row.original.versionNumber}
                kind={reason.kind}
              />
            )}
          </li>
        ))}
      </ul>
    ),
    filterFn: (row, id, value: string[]) =>
      (row.getValue(id) as string[]).some((kind) => value.includes(kind)),
    meta: { label: "Why it is listed" },
  },
];

export function AttentionScreen() {
  const [entries, setEntries] = React.useState<AttentionEntry[]>([]);
  const dropReason = React.useCallback(
    (ruleId: number, kind: AttentionKind) =>
      setEntries((current) => withoutReason(current, ruleId, kind)),
    [],
  );
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const { table, columnFilters } = useDataTable({
    data: entries,
    columns: columns as ColumnDef<AttentionEntry, unknown>[],
    getRowId: (row) => String(row.ruleId),
    enableRowSelection: false,
  });
  const filtered = (columnFilters as ColumnFiltersState).length > 0;

  React.useEffect(() => {
    let stale = false;
    listAttention()
      .then((next) => {
        if (stale) return;
        setEntries(next);
        setError(null);
      })
      .catch(
        (e: unknown) =>
          !stale && setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => !stale && setLoaded(true));
    return () => {
      stale = true;
    };
  }, [attempt]);

  return (
    <div className="w-full">
      <div className="mb-4 text-left">
        <h1 className="text-2xl font-bold tracking-tight">Needs attention</h1>
        <p className="mt-2 text-muted-foreground">
          Rules worth a look, worst first: wrong matches, rules that match much
          of what they see, rules that only just clear the cutoff, and rules
          that never match. When you have looked at a reason and the rule is
          doing what you want, "Looks fine" clears it until the rule's next
          version.
        </p>
      </div>
      <DataTableToolbar table={table}>
        <DataTableFacetedFilter
          column={table.getColumn("reason")}
          title="Why"
          options={kinds}
        />
        <DataTableFacetedFilter
          column={table.getColumn("checkType")}
          title="Type"
          options={checkTypes}
        />
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setAttempt((n) => n + 1)}
          >
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
      <ClearedContext.Provider value={dropReason}>
        <DataTable
          table={table}
          onRowClick={(entry) => navigate(`/rules/${entry.ruleId}`)}
          emptyMessage={
            !loaded
              ? "Loading..."
              : error
                ? "Could not load the list."
                : filtered
                  ? "No rules match."
                  : "Nothing needs attention. Rules appear here when they match wrongly, match often, only just clear the cutoff or never match."
          }
        />
      </ClearedContext.Provider>
      <DataTablePagination table={table} />
    </div>
  );
}
