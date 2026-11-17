// The Rules screen, built on the shadcnblocks block data-table12 (faceted
// filter data table).
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import { CircleDot, FileEdit, MessageSquare, Reply } from "lucide-react";
import * as React from "react";

import {
  DataTable,
  DataTableColumnHeader,
  DataTableFacetedFilter,
  DataTablePagination,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table";
import { NewRuleDialog } from "@/components/new-rule-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  type CheckType,
  listRules,
  type RuleState,
  type RuleSummary,
} from "@/lib/api";
import { followLink, navigate } from "@/lib/router";

export const checkTypes = [
  { value: "message", label: "Message", icon: MessageSquare },
  { value: "reply", label: "Reply", icon: Reply },
];

const states = [
  { value: "live", label: "Live", icon: CircleDot },
  { value: "draft", label: "Draft only", icon: FileEdit },
];

const drafts = [
  { value: "true", label: "Has a draft" },
  { value: "false", label: "No draft" },
];

const columns: ColumnDef<RuleSummary>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    cell: ({ row }) => (
      <a
        href={`/rules/${row.original.id}`}
        onClick={(event) => {
          event.stopPropagation();
          followLink(event);
        }}
        className="max-w-[500px] truncate font-medium hover:underline"
      >
        {row.original.name}
      </a>
    ),
    enableHiding: false,
    meta: { label: "Name" },
  },
  {
    accessorKey: "checkType",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Check" />,
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
    enableSorting: false,
    meta: { label: "Check" },
  },
  {
    accessorKey: "state",
    header: ({ column }) => <DataTableColumnHeader column={column} title="State" />,
    cell: ({ row }) =>
      row.original.state === "live" ? (
        <Badge className="gap-1 whitespace-nowrap">
          <CircleDot className="size-3" />
          Live
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1 whitespace-nowrap">
          <FileEdit className="size-3" />
          Draft only
        </Badge>
      ),
    enableSorting: false,
    meta: { label: "State" },
  },
  {
    id: "hasDraft",
    accessorFn: (row) => String(row.hasDraft),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Draft" />,
    cell: ({ row }) =>
      row.original.hasDraft ? (
        <Badge variant="secondary" className="whitespace-nowrap">
          Unpublished draft
        </Badge>
      ) : (
        <span className="text-muted-foreground">None</span>
      ),
    enableSorting: false,
    meta: { label: "Draft" },
  },
];

const values = (filters: ColumnFiltersState, id: string) =>
  filters.find((f) => f.id === id)?.value as string[] | undefined;

export function RulesScreen() {
  const [rules, setRules] = React.useState<RuleSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { table, globalFilter, columnFilters } = useDataTable({
    data: rules,
    columns: columns as ColumnDef<RuleSummary, unknown>[],
    getRowId: (row) => String(row.id),
    enableRowSelection: false,
    manualFiltering: true,
  });

  React.useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      listRules({
        search: globalFilter,
        checkType: values(columnFilters, "checkType") as CheckType[] | undefined,
        state: values(columnFilters, "state") as RuleState[] | undefined,
        hasDraft: values(columnFilters, "hasDraft")?.map((v) => v === "true"),
      })
        .then((next) => {
          if (stale) return;
          setRules(next);
          setError(null);
        })
        .catch((e: unknown) => !stale && setError(String(e instanceof Error ? e.message : e)))
        .finally(() => !stale && setLoaded(true));
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [globalFilter, columnFilters]);

  const filtering = globalFilter !== "" || columnFilters.length > 0;

  return (
    <div className="w-full">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="text-left">
          <h1 className="text-2xl font-bold tracking-tight">Rules</h1>
          <p className="mt-2 text-muted-foreground">
            Each rule is one or more conditions and an instruction. Edits go
            into a draft, which changes nothing until you publish it.
          </p>
        </div>
      </div>
      <DataTableToolbar table={table}>
        <Input
          placeholder="Search names, conditions and instructions..."
          value={globalFilter}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          className="h-8 w-full lg:w-[320px]"
          aria-label="Search rules"
        />
        <DataTableFacetedFilter
          column={table.getColumn("checkType")}
          title="Check"
          options={checkTypes}
        />
        <DataTableFacetedFilter
          column={table.getColumn("state")}
          title="State"
          options={states}
        />
        <DataTableFacetedFilter
          column={table.getColumn("hasDraft")}
          title="Draft"
          options={drafts}
        />
        <div className="ml-auto">
          <NewRuleDialog onCreated={(rule) => navigate(`/rules/${rule.id}`)} />
        </div>
      </DataTableToolbar>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <DataTable
        table={table}
        onRowClick={(rule) => navigate(`/rules/${rule.id}`)}
        emptyMessage={
          !loaded
            ? "Loading..."
            : filtering
              ? "No rules match."
              : "No rules yet. Create one with New rule."
        }
      />
      <DataTablePagination table={table} />
    </div>
  );
}
