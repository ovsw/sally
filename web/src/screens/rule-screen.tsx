// The Rule screen: the live version beside the draft, then the version
// history. The draft form follows the shadcnblocks block form-layouts-1
// (vertical field layout).
import {
  ArrowLeft,
  FilePen,
  Loader2,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";

import { RescoreDialog } from "@/components/rescore-dialog";
import { ConditionsField, InstructionField, SaveStatus } from "@/components/rule-fields";
import { RuleAnalyticsPanel } from "@/components/rule-analytics";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  deleteRule,
  discardDraft,
  getRule,
  listProjects,
  type Project,
  publish,
  type PublishedVersion,
  rescoreDraft,
  type RescoreResult,
  type RuleDetail,
  startDraftFrom,
  switchRule,
  type Scope,
  type VersionView,
} from "@/lib/api";
import { errorText, useDraftSaver } from "@/lib/draft-saver";
import { followLink, navigate } from "@/lib/router";

/** Typing in one field with pauses shorter than this is undone in one step. */
const UNDO_GROUP_MS = 1000;
const UNDO_LIMIT = 200;

/**
 * One undo step: the form as it was, whether it was a saved or pending draft,
 * and the live version it stood beside.
 */
interface UndoStep {
  content: VersionView;
  hadDraft: boolean;
  liveNumber: number | null;
}

function LiveVersion({ rule }: { rule: RuleDetail }) {
  const live = rule.live;
  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-medium">
          {rule.on ? "Live version" : "Live version (switched off)"}
        </h2>
        {live && <Badge variant="secondary">Version {live.number}</Badge>}
      </div>
      {live ? (
        <dl className="space-y-5 px-4 py-4 text-sm">
          <div className="space-y-1.5">
            <dt className="font-medium">Name</dt>
            <dd>{live.name}</dd>
          </div>
          <div className="space-y-1.5">
            <dt className="font-medium">
              {live.conditions.length === 1 ? "Condition" : "Conditions"}
            </dt>
            <dd>
              <ul className="space-y-1.5">
                {live.conditions.map((condition, i) => (
                  <li key={i} className="rounded-md bg-muted/50 px-3 py-2">
                    {condition}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div className="space-y-1.5">
            <dt className="font-medium">Instruction</dt>
            <dd className="rounded-md bg-muted/50 px-3 py-2 whitespace-pre-wrap">
              {live.instruction}
            </dd>
          </div>
          <div className="space-y-1.5">
            <dt className="font-medium">Scope</dt>
            <dd>
              {live.scope.kind === "all" ? (
                "All projects"
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {live.scope.projects.map((project) => (
                    <Badge key={project} variant="secondary">
                      {project}
                    </Badge>
                  ))}
                </div>
              )}
            </dd>
          </div>
          <p className="text-xs text-muted-foreground">
            Published {new Date(live.publishedAt).toLocaleString()}
          </p>
        </dl>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Not published yet. The engine does not use this rule until you
          publish its draft.
        </p>
      )}
    </section>
  );
}

interface ScopeFieldProps {
  value: Scope;
  onChange: (next: Scope) => void;
  /** The projects Sally has seen; null while they load or when loading failed. */
  projects: Project[] | null;
  /** Why the projects could not be loaded, if they could not. */
  projectsError: string | null;
  onRetryProjects: () => void;
}

function ScopeField({ value, onChange, projects, projectsError, onRetryProjects }: ScopeFieldProps) {
  const selected = value.kind === "projects" ? value.projects : [];
  // A project already in the scope stays listed even if the list has not loaded.
  const names = [...new Set([...(projects ?? []).map((p) => p.name), ...selected])].sort(
    (a, b) => a.localeCompare(b),
  );
  const toggle = (name: string, checked: boolean) =>
    onChange({
      kind: "projects",
      projects: checked
        ? [...selected, name]
        : selected.filter((project) => project !== name),
    });

  return (
    <Field>
      <FieldLabel htmlFor="draft-scope">Scope</FieldLabel>
      <Select
        value={value.kind}
        onValueChange={(kind) =>
          onChange(kind === "all" ? { kind: "all" } : { kind: "projects", projects: selected })
        }
      >
        <SelectTrigger id="draft-scope" className="w-full bg-background">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All projects</SelectItem>
          <SelectItem value="projects">Only some projects</SelectItem>
        </SelectContent>
      </Select>
      {value.kind === "projects" && projectsError && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>Could not load the projects: {projectsError}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetryProjects}>
            Retry
          </Button>
        </div>
      )}
      {value.kind === "projects" &&
        (names.length === 0 ? (
          !projectsError && (
            <p className="text-sm text-muted-foreground">
              {projects === null
                ? "Loading projects..."
                : "Sally has not seen any project yet. A project appears here after its first check."}
            </p>
          )
        ) : (
          <div className="space-y-3 rounded-md border bg-background p-3">
            {names.map((name, index) => (
              <Field key={name} orientation="horizontal">
                <Checkbox
                  id={`draft-project-${index}`}
                  checked={selected.includes(name)}
                  onCheckedChange={(checked) => toggle(name, checked === true)}
                />
                <FieldLabel htmlFor={`draft-project-${index}`} className="font-normal">
                  {name}
                </FieldLabel>
              </Field>
            ))}
          </div>
        ))}
      <FieldDescription>
        A project is a git repository, named by its remote, so every worktree
        of it counts as one project. Rules outside the session&apos;s project are
        never checked.
      </FieldDescription>
    </Field>
  );
}

interface DraftFormProps {
  value: VersionView;
  /** `field` names the field being typed in; null for a change made in one step. */
  onChange: (next: VersionView, field: string | null) => void;
  error: string | null;
  checkType: RuleDetail["checkType"];
  projects: Project[] | null;
  projectsError: string | null;
  onRetryProjects: () => void;
}

function DraftForm({
  value,
  onChange,
  error,
  checkType,
  projects,
  projectsError,
  onRetryProjects,
}: DraftFormProps) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="draft-name">Name</FieldLabel>
        <Input
          id="draft-name"
          className="bg-background"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value }, "name")}
        />
      </Field>
      <ConditionsField
        conditions={value.conditions}
        checkType={checkType}
        onChange={(conditions, field) => onChange({ ...value, conditions }, field)}
      />
      <InstructionField
        id="draft-instruction"
        instruction={value.instruction}
        onChange={(instruction) => onChange({ ...value, instruction }, "instruction")}
      />
      <ScopeField
        value={value.scope}
        onChange={(scope) => onChange({ ...value, scope }, null)}
        projects={projects}
        projectsError={projectsError}
        onRetryProjects={onRetryProjects}
      />
      {error && <FieldError>{error}</FieldError>}
    </FieldGroup>
  );
}

const contentOf = (rule: RuleDetail): VersionView => {
  const source = rule.draft ?? rule.live;
  return {
    name: source?.name ?? rule.name,
    instruction: source?.instruction ?? "",
    conditions: source?.conditions.length ? [...source.conditions] : [""],
    scope:
      source?.scope.kind === "projects"
        ? { kind: "projects", projects: [...source.scope.projects] }
        : { kind: "all" },
  };
};

function VersionHistory({
  rule,
  busy,
  onStartDraft,
}: {
  rule: RuleDetail;
  busy: boolean;
  onStartDraft: (version: PublishedVersion) => void;
}) {
  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-medium">Version history</h2>
        <span className="text-xs text-muted-foreground">
          Published versions never change
        </span>
      </div>
      {rule.versions.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No published versions yet.
        </p>
      ) : (
        <ol className="divide-y">
          {rule.versions.map((version) => (
            <li
              key={version.number}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {version.number}</span>
                  {version.number === rule.live?.number && (
                    <Badge variant="secondary">{rule.on ? "Live" : "Latest"}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Published {new Date(version.publishedAt).toLocaleString()}
                  </span>
                </div>
                {version.name !== rule.name && (
                  <p className="text-muted-foreground">Named "{version.name}"</p>
                )}
                <ul className="list-disc space-y-1 pl-5">
                  {version.conditions.map((condition, i) => (
                    <li key={i}>{condition}</li>
                  ))}
                </ul>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {version.instruction}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={busy}
                onClick={() => onStartDraft(version)}
              >
                <FilePen />
                Start a draft from this
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}


export function RuleScreen({ id }: { id: number }) {
  const [rule, setRuleState] = React.useState<RuleDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<VersionView | null>(null);
  const [projects, setProjects] = React.useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = React.useState<string | null>(null);
  const [projectsAttempt, setProjectsAttempt] = React.useState(0);
  const [action, setAction] = React.useState<string | null>(null);
  /** The draft's re-score against the saved cases, shown before publishing. */
  const [rescore, setRescore] = React.useState<Exclude<RescoreResult, { status: "no_cases" }> | null>(
    null,
  );
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [undoSteps, setUndoSteps] = React.useState(0);
  const ruleRef = React.useRef<RuleDetail | null>(null);
  const undoStack = React.useRef<UndoStep[]>([]);
  const lastTyped = React.useRef<{ field: string; at: number } | null>(null);
  /** Counts edits to the form, so a re-score knows whether the draft changed after it. */
  const edits = React.useRef(0);
  /** The edit count the shown re-score was made at. */
  const scoredAt = React.useRef(0);

  const setRule = React.useCallback((next: RuleDetail) => {
    ruleRef.current = next;
    setRuleState(next);
  }, []);
  const saver = useDraftSaver(id, setRule);
  const { state: save, setState: setSave, flush, replacing: replacingDraft } = saver;

  React.useEffect(() => {
    let stale = false;
    undoStack.current = [];
    setUndoSteps(0);
    getRule(id)
      .then((loaded) => {
        if (stale) return;
        setRule(loaded);
        setDraft(contentOf(loaded));
      })
      .catch((e: unknown) => !stale && setLoadError(errorText(e)));
    return () => {
      stale = true;
    };
  }, [id, setRule]);

  React.useEffect(() => {
    let stale = false;
    listProjects()
      .then((loaded) => !stale && setProjects(loaded))
      // Without the list, the projects already in the scope still show,
      // next to the error and a way to try again.
      .catch((e: unknown) => !stale && setProjectsError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [projectsAttempt]);

  const retryProjects = React.useCallback(() => {
    setProjectsError(null);
    setProjectsAttempt((n) => n + 1);
  }, []);

  const busySaving = save.kind === "pending" || save.kind === "saving";
  const showingDraft = (rule?.hasDraft ?? false) || busySaving;

  const undoStepNow = (): UndoStep => ({
    content: draft!,
    hadDraft: showingDraft,
    liveNumber: ruleRef.current?.live?.number ?? null,
  });

  const pushUndo = (step: UndoStep) => {
    undoStack.current.push(step);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoSteps(undoStack.current.length);
  };

  /** Puts `next` in the form and saves it into the draft after a pause. */
  const saveSoon = (next: VersionView) => {
    setDraft(next);
    setActionError(null);
    edits.current += 1;
    saver.saveSoon(next);
  };

  const edit = (next: VersionView, field: string | null) => {
    if (draft) {
      const now = Date.now();
      const last = lastTyped.current;
      const sameRun = field !== null && last?.field === field && now - last.at < UNDO_GROUP_MS;
      if (!sameRun) pushUndo(undoStepNow());
      lastTyped.current = field === null ? null : { field, at: now };
    }
    saveSoon(next);
  };

  /** Runs one action on the rule, showing it as busy and any refusal as an error. */
  const act = async (name: string, run: () => Promise<void>) => {
    setAction(name);
    setActionError(null);
    try {
      await run();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setAction(null);
    }
  };

  /** Drops the draft on the server, if it has one, and shows the live version in the form. */
  const dropDraft = () =>
    replacingDraft(async () => {
      const current = ruleRef.current!;
      const updated = current.hasDraft ? await discardDraft(id) : current;
      setRule(updated);
      setDraft(contentOf(updated));
      setSave({ kind: "idle" });
    });

  const undo = () =>
    act("undo", async () => {
      const step = undoStack.current.pop();
      setUndoSteps(undoStack.current.length);
      lastTyped.current = null;
      if (!step) return;
      // A step from before a publish holds content the live version no
      // longer has, so it comes back as a draft.
      const live = ruleRef.current?.live ?? null;
      if (step.hadDraft || !live || live.number !== step.liveNumber) {
        saveSoon(step.content);
      } else {
        await dropDraft();
      }
    });

  const discard = () =>
    act("discard", async () => {
      const before = undoStepNow();
      await dropDraft();
      pushUndo(before);
      lastTyped.current = null;
    });

  const startFrom = (version: PublishedVersion) =>
    act("start-draft", async () => {
      const before = undoStepNow();
      await replacingDraft(async () => {
        const updated = await startDraftFrom(id, version.number);
        setRule(updated);
        setDraft(contentOf(updated));
        setSave({ kind: "saved" });
      });
      pushUndo(before);
      lastTyped.current = null;
    });

  const publishNow = async () => {
    const result = await publish(id);
    setRule(result.rule);
    // Edits typed while publishing stay in the form and are saved as the
    // next draft.
    if (!saver.hasUnsent()) {
      setDraft(contentOf(result.rule));
      setSave({ kind: "idle" });
    }
  };

  /**
   * Publishing first scores the draft against the rule's saved cases and
   * shows the result; a rule with none publishes straight away.
   */
  const doPublish = () =>
    act("publish", async () => {
      // A draft the server refused must not be published as the old draft.
      if (!(await flush())) return;
      const at = edits.current;
      const result = await rescoreDraft(id);
      if (result.status === "no_cases") return publishNow();
      scoredAt.current = at;
      setRescore(result);
    });

  const publishAnyway = () => {
    setRescore(null);
    // The form stays editable while the draft is scored, so the shown result
    // may be for an older draft. Score the current one again instead of
    // publishing what the user has not seen scored.
    if (edits.current !== scoredAt.current) {
      void doPublish();
      return;
    }
    void act("publish", async () => {
      if (!(await flush())) return;
      await publishNow();
    });
  };

  const toggle = (on: boolean) =>
    act("switch", async () => {
      // In line with the saves, so a save answered earlier cannot show the
      // rule's old on or off after this.
      setRule(await saver.inLine(() => switchRule(id, on)));
    });

  const remove = () =>
    act("delete", async () => {
      await replacingDraft(async () => {
        await deleteRule(id);
      });
      navigate("/rules");
    });

  if (loadError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    );
  }
  if (!rule || !draft) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const acting = action !== null;
  // While the draft is being replaced, edits would be lost, so the form waits.
  const replacing =
    action === "start-draft" || action === "discard" || action === "undo" || action === "delete";
  const canPublish = (rule.hasDraft || busySaving) && save.kind !== "error" && !acting;
  const canDiscard = rule.live !== null && showingDraft && !acting;

  return (
    <div className="w-full space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{rule.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {rule.checkType === "message" ? "Message check" : "Reply check"}
            </Badge>
            {rule.state === "live" ? (
              <Badge>Live</Badge>
            ) : rule.state === "off" ? (
              <Badge variant="secondary">Off</Badge>
            ) : (
              <Badge variant="outline">Draft only</Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <SaveStatus state={save} hasDraft={rule.hasDraft} />
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={rule.on}
              disabled={acting}
              onCheckedChange={(on) => void toggle(on)}
              aria-label="Rule on"
            />
            {rule.on ? "On" : "Off"}
          </label>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={acting}>
                <Trash2 />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{rule.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  The rule, all its versions and its draft are deleted for good.
                  To pause it and keep its history, switch it off instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  Delete rule
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button onClick={() => void doPublish()} disabled={!canPublish}>
            {action === "publish" ? <Loader2 className="animate-spin" /> : <Upload />}
            Publish
          </Button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LiveVersion rule={rule} />
        <section className="rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Draft</h2>
              <span className="text-xs text-muted-foreground">
                {showingDraft ? "Edits save automatically" : "Editing starts a draft"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void undo()}
                disabled={undoSteps === 0 || acting}
              >
                <Undo2 />
                Undo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void discard()}
                disabled={!canDiscard}
              >
                <X />
                Discard draft
              </Button>
            </div>
          </div>
          <fieldset disabled={replacing} className="min-w-0 px-4 py-4">
            <DraftForm
              value={draft}
              onChange={edit}
              checkType={rule.draft?.checkType ?? rule.checkType}
              projects={projects}
              projectsError={projectsError}
              onRetryProjects={retryProjects}
              error={save.kind === "error" ? save.message : null}
            />
          </fieldset>
        </section>
      </div>
      <RescoreDialog result={rescore} onPublish={publishAnyway} onBack={() => setRescore(null)} />
      <VersionHistory rule={rule} busy={acting} onStartDraft={(v) => void startFrom(v)} />
      {/* Reloads after a publish, so the new version shows. */}
      <RuleAnalyticsPanel key={rule.live?.number ?? 0} id={id} />
    </div>
  );
}

function BackLink() {
  return (
    <a
      href="/rules"
      onClick={followLink}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Rules
    </a>
  );
}
