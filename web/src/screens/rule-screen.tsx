// The Rule panel, opened beside the rules list: the rule's scope, the published version beside the
// draft, then the version history. The draft form and the scope follow the shadcnblocks block
// form-layouts-1 (vertical field layout).
import { LabelWithHelp, ruleHelp } from "@/components/field-help";
import {
  FilePen,
  Loader2,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";

import { RescoreDialog } from "@/components/rescore-dialog";
import {
  ConditionsField,
  InstructionField,
  NameField,
  publishedConditionIds,
  SaveStatus,
} from "@/components/rule-fields";
import { RuleAnalyticsPanel } from "@/components/rule-analytics";
import { RuleStatus } from "@/components/rule-status";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type ConditionView,
  deleteRule,
  discardDraft,
  type DraftContent,
  getRule,
  listProjects,
  type Project,
  publish,
  type PublishedVersion,
  rescoreDraft,
  type RescoreResult,
  type RuleDetail,
  setScope,
  startDraftFrom,
  switchRule,
  type Scope,
} from "@/lib/api";
import { errorText, useDraftSaver } from "@/lib/draft-saver";
import { CHECK_LABELS } from "@/lib/format";
import { navigate } from "@/lib/router";
import { announceRuleChange, useRuleChanges } from "@/lib/rule-events";

/** Typing in one field with pauses shorter than this is undone in one step. */
const UNDO_GROUP_MS = 1000;
const UNDO_LIMIT = 200;

/**
 * One undo step: the form as it was, whether it was a saved or pending draft,
 * and the live version it stood beside.
 */
interface UndoStep {
  content: DraftContent;
  hadDraft: boolean;
  liveNumber: number | null;
}

/** Which checks use a condition, as small badges; "Off" when neither does. */
function ConditionChecks({ condition }: { condition: ConditionView }) {
  const on = [condition.message && "Message", condition.reply && "Reply"].filter(Boolean) as string[];
  return (
    <span className="flex shrink-0 gap-1">
      {(on.length ? on : ["Off"]).map((label) => (
        <Badge key={label} variant={label === "Off" ? "secondary" : "outline"} className="font-normal">
          {label}
        </Badge>
      ))}
    </span>
  );
}

function PublishedVersion({ rule }: { rule: RuleDetail }) {
  const live = rule.live;
  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-medium">Published version</h2>
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
                {live.conditions.map((condition) => (
                  <li
                    key={condition.id}
                    className="flex items-start justify-between gap-3 rounded-md bg-muted/50 px-3 py-2"
                  >
                    <span className="min-w-0">{condition.text}</span>
                    <ConditionChecks condition={condition} />
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
      <LabelWithHelp htmlFor="rule-scope" label="Scope">
        {ruleHelp.scope}
      </LabelWithHelp>
      <Select
        value={value.kind}
        onValueChange={(kind) =>
          onChange(kind === "all" ? { kind: "all" } : { kind: "projects", projects: selected })
        }
      >
        <SelectTrigger id="rule-scope" className="w-full bg-background">
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
                  id={`rule-project-${index}`}
                  checked={selected.includes(name)}
                  onCheckedChange={(checked) => toggle(name, checked === true)}
                />
                <FieldLabel htmlFor={`rule-project-${index}`} className="font-normal">
                  {name}
                </FieldLabel>
              </Field>
            ))}
          </div>
        ))}
      {value.kind === "projects" && value.projects.length === 0 && names.length > 0 && (
        <FieldDescription>Pick at least one project. Until then the rule keeps the scope it has.</FieldDescription>
      )}
    </Field>
  );
}

/** A scope a rule can have: all projects, or at least one project. */
const completeScope = (scope: Scope) => scope.kind === "all" || scope.projects.length > 0;

interface ScopeSectionProps {
  /** The rule's scope as the server last said. */
  scope: Scope;
  /** Stores a complete scope; resolves once the server has it, rejects if it refused. */
  onSave: (scope: Scope) => Promise<void>;
  disabled: boolean;
  projects: Project[] | null;
  projectsError: string | null;
  onRetryProjects: () => void;
}

/**
 * The rule's scope, outside the draft: each complete choice is stored at once.
 * A list of projects with none ticked yet stays here until one is.
 */
function ScopeSection({ scope, onSave, disabled, projects, projectsError, onRetryProjects }: ScopeSectionProps) {
  const [value, setValue] = React.useState<Scope>(scope);
  const [error, setError] = React.useState<string | null>(null);
  /** Scopes sent and not yet answered: the server's answer to an earlier one must not undo a later choice. */
  const pending = React.useRef(0);
  const latest = React.useRef(scope);
  const serverScope = JSON.stringify(scope);
  React.useEffect(() => {
    latest.current = JSON.parse(serverScope) as Scope;
    if (pending.current === 0) setValue(latest.current);
  }, [serverScope]);

  const change = (next: Scope) => {
    setValue(next);
    setError(null);
    if (!completeScope(next)) return;
    pending.current += 1;
    onSave(next)
      .catch((e: unknown) => {
        setError(errorText(e));
        // Back to what the server has, once nothing else is on its way.
        if (pending.current === 1) setValue(latest.current);
      })
      .finally(() => {
        pending.current -= 1;
      });
  };

  return (
    <section className="rounded-md border">
      <fieldset disabled={disabled} className="min-w-0 px-4 py-4">
        <FieldGroup>
          <ScopeField
            value={value}
            onChange={change}
            projects={projects}
            projectsError={projectsError}
            onRetryProjects={onRetryProjects}
          />
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
      </fieldset>
    </section>
  );
}

interface DraftFormProps {
  value: DraftContent;
  /** `field` names the field being typed in; null for a change made in one step. */
  onChange: (next: DraftContent, field: string | null) => void;
  error: string | null;
  /** The conditions already published, whose switches the draft does not change. */
  published: ReadonlySet<number>;
}

function DraftForm({ value, onChange, error, published }: DraftFormProps) {
  return (
    <FieldGroup>
      <NameField id="draft-name" name={value.name} onChange={(name) => onChange({ ...value, name }, "name")} />
      <ConditionsField
        conditions={value.conditions}
        published={published}
        onChange={(conditions, field) => onChange({ ...value, conditions }, field)}
      />
      <InstructionField
        id="draft-instruction"
        instruction={value.instruction}
        onChange={(instruction) => onChange({ ...value, instruction }, "instruction")}
      />
      {error && <FieldError>{error}</FieldError>}
    </FieldGroup>
  );
}

/**
 * `content` with each new condition given the id the server gave it in
 * `published`, so a later save keeps that condition instead of starting
 * another. A new condition is the published one with the same wording, or,
 * when none was added or removed since, the one in the same place.
 */
const withPublishedIds = (content: DraftContent, published: ConditionView[]): DraftContent => {
  const taken = new Set(content.conditions.map((condition) => condition.id));
  const samePlaces = content.conditions.length === published.length;
  const conditions = content.conditions.map((condition, index) => {
    if (condition.id !== undefined) return condition;
    const free = (candidate: ConditionView | undefined) => candidate !== undefined && !taken.has(candidate.id);
    const sameWording = published.find((candidate) => free(candidate) && candidate.text === condition.text.trim());
    const match = sameWording ?? (samePlaces && free(published[index]) ? published[index] : undefined);
    if (!match) return condition;
    taken.add(match.id);
    return { ...condition, id: match.id };
  });
  return { ...content, conditions };
};

/** `content` with every published condition's switches as they are in force: a draft cannot change those. */
const withPublishedSwitches = (content: DraftContent, published: ConditionView[]): DraftContent => ({
  ...content,
  conditions: content.conditions.map((condition) => {
    const live = published.find((candidate) => candidate.id === condition.id);
    return live ? { ...condition, message: live.message, reply: live.reply } : condition;
  }),
});

const contentOf = (rule: RuleDetail): DraftContent => {
  const source = rule.draft ?? rule.live;
  return {
    name: source?.name ?? rule.name,
    instruction: source?.instruction ?? "",
    conditions: source?.conditions.length
      ? source.conditions.map((condition) => ({ ...condition }))
      : [{ text: "", message: true, reply: false }],
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
              className="flex flex-col gap-3 px-4 py-4 @xl:flex-row @xl:items-start @xl:justify-between"
            >
              <div className="min-w-0 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {version.number}</span>
                  {version.number === rule.live?.number && (
                    <Badge variant="secondary">Latest</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Published {new Date(version.publishedAt).toLocaleString()}
                  </span>
                </div>
                {version.name !== rule.name && (
                  <p className="text-muted-foreground">Named "{version.name}"</p>
                )}
                <ul className="list-disc space-y-1 pl-5">
                  {version.conditions.map((condition) => (
                    <li key={condition.id}>{condition.text}</li>
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
  const [draft, setDraft] = React.useState<DraftContent | null>(null);
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

  /** The on or off last asked for here, until the server has answered it. */
  const switching = React.useRef<{ on: boolean; click: number } | null>(null);
  const switchClicks = React.useRef(0);
  /** On or off as the server last said. */
  const confirmedOn = React.useRef<boolean | null>(null);
  /** Switched from the list before this rule had loaded. */
  const switchedEarly = React.useRef<boolean | null>(null);

  const setRule = React.useCallback((next: RuleDetail) => {
    confirmedOn.current = next.on;
    // A save answered while a switch is under way still shows the switch's position.
    const shown = switching.current ? { ...next, on: switching.current.on } : next;
    ruleRef.current = shown;
    setRuleState(shown);
    announceRuleChange({ rule: shown });
  }, []);
  // Switched on or off from the list: only that changes here, so a draft
  // being saved is not disturbed.
  useRuleChanges((change) => {
    const current = ruleRef.current;
    if (!("rule" in change) || change.rule === current || change.rule.id !== id) return;
    if (!current) {
      switchedEarly.current = change.rule.on;
      return;
    }
    confirmedOn.current = change.rule.on;
    if (switching.current || change.rule.on === current.on) return;
    const next = { ...current, on: change.rule.on };
    ruleRef.current = next;
    setRuleState(next);
  });
  const saver = useDraftSaver(id, setRule);
  const { state: save, setState: setSave, flush, replacing: replacingDraft } = saver;

  React.useEffect(() => {
    let stale = false;
    undoStack.current = [];
    setUndoSteps(0);
    switchedEarly.current = null;
    getRule(id)
      .then((answer) => {
        if (stale) return;
        // The answer may predate a switch made from the list meanwhile.
        const early = switchedEarly.current;
        const loaded = early === null ? answer : { ...answer, on: early };
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
  const saveSoon = (next: DraftContent) => {
    setDraft(next);
    setActionError(null);
    edits.current += 1;
    saver.saveSoon(next);
  };

  const edit = (next: DraftContent, field: string | null) => {
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
        // An undo cannot move the switches of a condition published since.
        saveSoon(live ? withPublishedSwitches(step.content, live.conditions) : step.content);
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
    // In line with scope changes, so an older publish response cannot replace
    // a scope chosen while publishing.
    const result = await saver.inLine(async () => {
      const published = await publish(id);
      setRule(published.rule);
      return published;
    });
    // Edits typed while publishing stay in the form and are saved as the
    // next draft.
    if (!saver.hasUnsent()) {
      setDraft(contentOf(result.rule));
      setSave({ kind: "idle" });
    } else {
      // The conditions just published have ids now; the edits kept must use them.
      const adopt = (content: DraftContent) => withPublishedIds(content, result.rule.live?.conditions ?? []);
      setDraft((current) => current && adopt(current));
      saver.amendUnsent(adopt);
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

  /** Shows a change to the rule here only, before the server has it. */
  const showAhead = (next: RuleDetail) => {
    ruleRef.current = next;
    setRuleState(next);
  };

  // The switch moves at once and goes back only if the server refuses.
  const toggle = async (on: boolean) => {
    const click = ++switchClicks.current;
    switching.current = { on, click };
    showAhead({ ...ruleRef.current!, on });
    setActionError(null);
    const last = () => switching.current?.click === click;
    try {
      // In line with the saves and earlier switches, so the last click is what is stored.
      const next = await saver.inLine(() => switchRule(id, on));
      if (last()) switching.current = null;
      setRule(next);
    } catch (e) {
      if (last()) {
        switching.current = null;
        showAhead({ ...ruleRef.current!, on: confirmedOn.current ?? !on });
      }
      setActionError(errorText(e));
    }
  };

  // In line with the saves, so the last scope chosen is what is stored and shown.
  const saveScope = async (scope: Scope) => {
    await saver.inLine(async () => setRule(await setScope(id, scope)));
  };

  const remove = () =>
    act("delete", async () => {
      await replacingDraft(async () => {
        await deleteRule(id);
      });
      announceRuleChange({ deleted: id });
      navigate("/rules");
    });

  if (loadError) {
    return (
      <div className="flex items-start justify-between gap-4">
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
        <CloseButton />
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
  const publishedIds = publishedConditionIds(rule);

  return (
    <div className="@container w-full space-y-6">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">{rule.name}</h1>
            <div className="flex flex-wrap items-center gap-2">
              {rule.checkTypes.map((type) => (
                <Badge key={type} variant="outline">
                  {CHECK_LABELS[type]}
                </Badge>
              ))}
              <RuleStatus published={rule.published} hasDraft={rule.hasDraft} />
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
        <CloseButton />
      </div>
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      <ScopeSection
        scope={rule.scope}
        onSave={saveScope}
        disabled={replacing}
        projects={projects}
        projectsError={projectsError}
        onRetryProjects={retryProjects}
      />
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-2">
        <PublishedVersion rule={rule} />
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
              published={publishedIds}
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

/** Closes the panel, leaving the rules list. */
function CloseButton() {
  return (
    <Button variant="ghost" size="icon" aria-label="Close" onClick={() => navigate("/rules")}>
      <X />
    </Button>
  );
}
