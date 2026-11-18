// The Rules screen, built on the shadcnblocks block data-table12 (faceted
// filter data table).
import type { ColumnDef, ColumnFiltersState } from "@tanstack/react-table";
import { BookOpen, CircleDot, CirclePause, FileEdit, ListChecks, MessageSquare, PenLine, Reply } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  { value: "off", label: "Off", icon: CirclePause },
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
      ) : row.original.state === "off" ? (
        <Badge variant="secondary" className="gap-1 whitespace-nowrap">
          <CirclePause className="size-3" />
          Off
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

// Built on the shadcnblocks block empty-actions-2 (empty state with two
// actions): a new user is pointed to the import and to writing a first rule.
function NoRulesYet() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListChecks />
        </EmptyMedia>
        <EmptyTitle>No rules yet</EmptyTitle>
        <EmptyDescription>
          Sally does nothing until it has rules. Import the rules you already have
          in your rules files, or write your first rule here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <a href="/guide#importing" onClick={followLink}>
              <BookOpen />
              Import your rules
            </a>
          </Button>
          <NewRuleDialog
            onCreated={(rule) => navigate(`/rules/${rule.id}`)}
            trigger={
              <Button variant="outline">
                <PenLine />
                Write your first rule
              </Button>
            }
          />
        </div>
        <p className="text-sm text-muted-foreground">
          To import, type <code className="rounded bg-muted px-1 py-0.5 text-foreground">/sally-import</code> in
          Claude Code.
        </p>
      </EmptyContent>
    </Empty>
  );
}

const values = (filters: ColumnFiltersState, id: string) =>
  filters.find((f) => f.id === id)?.value as string[] | undefined;

export function RulesScreen() {
  const [rules, setRules] = React.useState<RuleSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  // Whether the rules shown came from a request with no search or filter.
  const [shownUnfiltered, setShownUnfiltered] = React.useState(false);
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
    const unfiltered = globalFilter === "" && columnFilters.length === 0;
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
          setShownUnfiltered(unfiltered);
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
  // Only an unfiltered answer says there are no rules: right after a search is
  // cleared, the empty result of that search is still showing.
  const noRules = loaded && !error && !filtering && shownUnfiltered && rules.length === 0;

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
      {noRules ? (
        <NoRulesYet />
      ) : (
        <>
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
            {/* Only once the first list is in: it may swap this toolbar for the first-run panel. */}
            {loaded && (
              <div className="ml-auto">
                <NewRuleDialog onCreated={(rule) => navigate(`/rules/${rule.id}`)} />
              </div>
            )}
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
                : "No rules match."
            }
          />
          <DataTablePagination table={table} />
        </>
      )}
    </div>
  );
}
