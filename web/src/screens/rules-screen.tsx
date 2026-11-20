// The Rules screen, built on the shadcnblocks block data-table12 (faceted
// filter data table). An open rule shows in a panel beside the list, as in
// Sanity, built on the shadcnblocks block resizable-with-scroll-area.
import type { ColumnDef, ColumnFiltersState, Table } from "@tanstack/react-table";
import { BookOpen, FolderGit2, Globe, ListChecks, MessageSquare, PenLine, Power, PowerOff, Reply, X } from "lucide-react";
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
import { RuleLights } from "@/components/rule-status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  type CheckType,
  listRules,
  type RuleSummary,
  type Scope,
  switchRule,
  switchRules,
} from "@/lib/api";
import { errorText } from "@/lib/draft-saver";
import { followLink, navigate } from "@/lib/router";
import { announceRuleChange, useRuleChanges } from "@/lib/rule-events";
import { RuleScreen } from "@/screens/rule-screen";

export const checkTypes = [
  { value: "message", label: "User message", icon: MessageSquare },
  { value: "reply", label: "Agent reply", icon: Reply },
];

const publishedOptions = [
  { value: "true", label: "Published" },
  { value: "false", label: "Not published" },
];

const onOptions = [
  { value: "true", label: "On", icon: Power },
  { value: "false", label: "Off", icon: PowerOff },
];

const scopes = [
  { value: "true", label: "All projects", icon: Globe },
  { value: "false", label: "Only some projects", icon: FolderGit2 },
];

/**
 * An icon and its label. `compact` (beside an open rule) shows the icon alone,
 * with the label on hover; `hint`, when given, shows on hover either way.
 */
function IconLabel({
  icon: Icon,
  label,
  hint,
  compact,
  muted = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: React.ReactNode;
  compact: boolean;
  muted?: boolean;
}) {
  const shown = (
    <span className={`flex min-w-0 items-center gap-2 ${muted ? "text-muted-foreground" : ""}`}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {compact ? <span className="sr-only">{label}</span> : <span className="max-w-[240px] truncate">{label}</span>}
    </span>
  );
  if (!compact && hint === undefined) return shown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{shown}</TooltipTrigger>
      <TooltipContent>{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** All projects, or the named ones: one by name, several by count with the names on hover. */
function ScopeCell({ scope, compact }: { scope: Scope; compact: boolean }) {
  if (scope.kind === "all") return <IconLabel icon={Globe} label="All projects" compact={compact} />;
  const label = scope.projects.length === 1 ? scope.projects[0]! : `${scope.projects.length} projects`;
  const names = scope.projects.map((project) => <div key={project}>{project}</div>);
  // Rules for named projects stand out from those for all projects.
  return <IconLabel icon={FolderGit2} label={label} hint={names} compact={compact} muted={false} />;
}

const drafts = [
  { value: "true", label: "Has a draft" },
  { value: "false", label: "No draft" },
];

/**
 * Switches a rule on or off right from the list. The switch moves at once and
 * holds there until the reloaded list agrees; it goes back only if the server
 * refuses.
 */
function OnSwitch({ rule, onError }: { rule: RuleSummary; onError: (message: string) => void }) {
  // The position asked for, shown until the server has answered the last click.
  const [wanted, setWanted] = React.useState<boolean | null>(null);
  const clicks = React.useRef(0);
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const toggle = (on: boolean) => {
    const click = ++clicks.current;
    setWanted(on);
    // One request at a time, in click order, so the last click is what is stored.
    const request = queue.current.then(() => switchRule(rule.id, on));
    queue.current = request.catch(() => undefined);
    request
      .then((next) => {
        // The list takes the answer in the same render, so the switch does not bounce.
        announceRuleChange({ rule: next });
        if (click === clicks.current) setWanted(null);
      })
      .catch((e: unknown) => {
        if (click === clicks.current) setWanted(null);
        onError(errorText(e));
      });
  };
  return (
    // The row opens the rule on a click; the switch only switches.
    <span className="flex" onClick={(event) => event.stopPropagation()}>
      <Switch checked={wanted ?? rule.on} onCheckedChange={toggle} aria-label={`${rule.name} on`} />
    </span>
  );
}

/** `compact`: beside an open rule, where the list is narrow and the name takes what room there is. */
function makeColumns(onError: (message: string) => void, compact: boolean): ColumnDef<RuleSummary>[] {
  return [
    {
      // Picks rules for the bar above the list, which switches them all at once.
      id: "select",
      header: ({ table }) => (
        <span className="flex">
          <Checkbox
            checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")}
            onCheckedChange={(checked) => table.toggleAllRowsSelected(checked === true)}
            disabled={table.getRowCount() === 0}
            aria-label="Select all rules"
          />
        </span>
      ),
      cell: ({ row }) => (
        // The row opens the rule on a click; the box only picks it.
        <span className="flex" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(checked === true)}
            aria-label={`Select ${row.original.name}`}
          />
        </span>
      ),
      enableHiding: false,
      enableSorting: false,
      meta: { className: "w-px" },
    },
    {
      id: "on",
      accessorFn: (row) => String(row.on),
      header: () => <span className="sr-only">On</span>,
      cell: ({ row }) => <OnSwitch rule={row.original} onError={onError} />,
      enableHiding: false,
      enableSorting: false,
      meta: { className: "w-px" },
    },
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
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
          <RuleLights published={row.original.published} hasDraft={row.original.hasDraft} />
        </span>
      ),
      enableHiding: false,
      // On the full list the name is as wide as the longest one, so the type sits right after it.
      meta: { label: "Name", className: compact ? undefined : "w-px pr-12" },
    },
    {
      // The checks the rule takes part in; filtering by one lists every rule with a condition on for it.
      id: "checkType",
      accessorFn: (row) => row.checkTypes,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-3">
          {checkTypes
            .filter((t) => row.original.checkTypes.includes(t.value as CheckType))
            .map((meta) => (
              <IconLabel key={meta.value} icon={meta.icon} label={meta.label} compact={compact} />
            ))}
        </span>
      ),
      enableSorting: false,
      meta: { label: "Type", className: compact ? "w-px" : "w-px pr-12" },
    },
    {
      id: "allProjects",
      accessorFn: (row) => String(row.scope.kind === "all"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Scope" />,
      cell: ({ row }) => <ScopeCell scope={row.original.scope} compact={compact} />,
      enableSorting: false,
      meta: { label: "Scope", className: compact ? "w-px" : undefined },
    },
    // Only for the Published and Draft filters: the lights by the name show both.
    { id: "published", accessorFn: (row) => String(row.published), enableHiding: false, enableSorting: false },
    { id: "hasDraft", accessorFn: (row) => String(row.hasDraft), enableHiding: false, enableSorting: false },
  ];
}

/**
 * Shown while rules are picked: switches them all on or all off in one click.
 * A rule that cannot come on (none of its conditions is on) stays off and is
 * named in the error; the others still switch.
 */
function BulkSwitchBar({
  table,
  onError,
}: {
  table: Table<RuleSummary>;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const picked = table.getSelectedRowModel().rows.map((row) => row.original);
  if (picked.length === 0) return null;
  const switchAll = (on: boolean) => {
    setBusy(true);
    onError(null);
    switchRules(
      picked.map((rule) => rule.id),
      on,
    )
      .then(({ rules, refused }) => {
        for (const rule of rules) announceRuleChange({ rule });
        table.resetRowSelection();
        if (refused.length > 0) onError(refusedText(refused, picked, on));
      })
      .catch((e: unknown) => onError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="sticky bottom-4 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-md">
      <span className="text-sm font-medium">
        {picked.length} {picked.length === 1 ? "rule" : "rules"} selected
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || picked.every((rule) => rule.on)}
          onClick={() => switchAll(true)}
        >
          <Power />
          Switch on
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || picked.every((rule) => !rule.on)}
          onClick={() => switchAll(false)}
        >
          <PowerOff />
          Switch off
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => table.resetRowSelection()}>
          <X />
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Which picked rules a bulk switch left as they were, grouped by why. */
function refusedText(refused: { ruleId: number; reason: string }[], picked: RuleSummary[], on: boolean): string {
  const nameOf = (id: number) => picked.find((rule) => rule.id === id)?.name ?? `Rule ${id}`;
  const byReason = new Map<string, string[]>();
  for (const { ruleId, reason } of refused) byReason.set(reason, [...(byReason.get(reason) ?? []), nameOf(ruleId)]);
  const stayed = on ? "Stayed off" : "Stayed on";
  return [...byReason].map(([reason, names]) => `${stayed}: ${names.join(", ")}. ${reason}`).join(" ");
}

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

/** The rules list; with `openId`, that rule open in a panel beside it. */
export function RulesScreen({ openId }: { openId?: number }) {
  const [rules, setRules] = React.useState<RuleSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  // Whether the rules shown came from a request with no search or filter.
  const [shownUnfiltered, setShownUnfiltered] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Kept apart from `error`, which the reload after the switch clears.
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  // Counts rule changes made here or in the panel, so the list reloads.
  const [changes, setChanges] = React.useState(0);
  useRuleChanges((change) => {
    // Shown at once, then confirmed by a fresh list.
    if ("rule" in change) {
      const { id, name, checkTypes, published, scope, on, hasDraft } = change.rule;
      setRules((rows) =>
        rows.map((row) => (row.id === id ? { id, name, checkTypes, published, scope, on, hasDraft } : row)),
      );
    }
    setChanges((n) => n + 1);
  });
  const compact = openId !== undefined;
  const columns = React.useMemo(() => makeColumns(setError, compact), [compact]);
  const { table, globalFilter, columnFilters } = useDataTable({
    data: rules,
    columns: columns as ColumnDef<RuleSummary, unknown>[],
    getRowId: (row) => String(row.id),
    manualFiltering: true,
    initialVisibility: { published: false, hasDraft: false },
  });
  const isMobile = useIsMobile();
  // A new search or filter starts the picking over, so no rule out of sight stays picked.
  React.useEffect(() => {
    table.resetRowSelection();
    setSwitchError(null);
  }, [table, globalFilter, columnFilters]);

  React.useEffect(() => {
    let stale = false;
    const unfiltered = globalFilter === "" && columnFilters.length === 0;
    const timer = window.setTimeout(() => {
      listRules({
        search: globalFilter,
        checkType: values(columnFilters, "checkType") as CheckType[] | undefined,
        published: values(columnFilters, "published")?.map((v) => v === "true"),
        on: values(columnFilters, "on")?.map((v) => v === "true"),
        hasDraft: values(columnFilters, "hasDraft")?.map((v) => v === "true"),
        allProjects: values(columnFilters, "allProjects")?.map((v) => v === "true"),
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
  }, [globalFilter, columnFilters, changes]);

  const filtering = globalFilter !== "" || columnFilters.length > 0;
  // Only an unfiltered answer says there are no rules: right after a search is
  // cleared, the empty result of that search is still showing.
  const noRules = loaded && !error && !filtering && shownUnfiltered && rules.length === 0;

  const header = (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="text-left">
        <h1 className="text-2xl font-bold tracking-tight">Rules</h1>
        <p className="mt-2 text-muted-foreground">
          Each rule is one or more conditions and an instruction. Edits go
          into a draft, which changes nothing until you publish it.
        </p>
      </div>
      {/* Only once the first list is in: it may swap the list for the first-run panel. */}
      {loaded && !noRules && <NewRuleDialog onCreated={(rule) => navigate(`/rules/${rule.id}`)} />}
    </div>
  );

  const list = noRules ? (
    <NoRulesYet />
  ) : (
    <>
      <DataTableToolbar table={table} showViewOptions={openId === undefined}>
        <Input
          placeholder="Search names, conditions and instructions..."
          value={globalFilter}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          className="h-8 w-full lg:w-[320px]"
          aria-label="Search rules"
        />
        <DataTableFacetedFilter
          column={table.getColumn("checkType")}
          title="Type"
          options={checkTypes}
        />
        <DataTableFacetedFilter
          column={table.getColumn("allProjects")}
          title="Scope"
          options={scopes}
        />
        <DataTableFacetedFilter
          column={table.getColumn("published")}
          title="Published"
          options={publishedOptions}
        />
        <DataTableFacetedFilter
          column={table.getColumn("hasDraft")}
          title="Draft"
          options={drafts}
        />
        <DataTableFacetedFilter
          column={table.getColumn("on")}
          title="On/Off"
          options={onOptions}
        />
      </DataTableToolbar>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <DataTable
        table={table}
        onRowClick={(rule) => navigate(`/rules/${rule.id}`)}
        activeRowId={openId === undefined ? undefined : String(openId)}
        emptyMessage={!loaded ? "Loading..." : "No rules match."}
      />
      {/* Below the list, so picking a rule never moves the rows under the pointer. */}
      <BulkSwitchBar table={table} onError={setSwitchError} />
      {switchError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {switchError}
        </p>
      )}
      <DataTablePagination table={table} />
    </>
  );

  if (openId === undefined) {
    return (
      <div className="w-full">
        {header}
        {list}
      </div>
    );
  }
  const panel = <RuleScreen key={openId} id={openId} />;
  // A phone has no room beside the list: the rule takes the screen.
  if (isMobile) return <div className="w-full">{panel}</div>;
  return (
    <div className="flex h-[calc(100svh-4rem)] w-full flex-col">
      {header}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 rounded-lg border">
        <ResizablePanel defaultSize="40%" minSize="25%">
          <div className="h-full overflow-auto p-3">{list}</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="60%" minSize="35%">
          <div className="h-full overflow-auto p-4">{panel}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
