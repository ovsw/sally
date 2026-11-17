// The Rule screen: the live version beside the draft. The draft form follows
// the shadcnblocks block form-layouts-1 (vertical field layout).
import { ArrowLeft, Check, Loader2, Plus, Upload, X } from "lucide-react";
import * as React from "react";

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
import { Textarea } from "@/components/ui/textarea";
import {
  getRule,
  listProjects,
  type Project,
  publish,
  type RuleDetail,
  saveDraft,
  type Scope,
  type VersionView,
} from "@/lib/api";
import { followLink } from "@/lib/router";

const SAVE_DELAY_MS = 500;

type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

function SaveStatus({ state, hasDraft }: { state: SaveState; hasDraft: boolean }) {
  const text =
    state.kind === "pending" || state.kind === "saving"
      ? "Saving..."
      : state.kind === "saved"
        ? "Draft saved"
        : state.kind === "error"
          ? "Not saved"
          : hasDraft
            ? "Draft saved"
            : "No draft";
  return (
    <span
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
      aria-live="polite"
    >
      {state.kind === "pending" || state.kind === "saving" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : state.kind === "error" ? (
        <X className="size-4 text-destructive" />
      ) : hasDraft ? (
        <Check className="size-4" />
      ) : null}
      {text}
    </span>
  );
}

function LiveVersion({ rule }: { rule: RuleDetail }) {
  const live = rule.live;
  return (
    <section className="rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="font-medium">Live version</h2>
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
  /** The projects Sally has seen; null while they load. */
  projects: Project[] | null;
}

function ScopeField({ value, onChange, projects }: ScopeFieldProps) {
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
      {value.kind === "projects" &&
        (names.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {projects === null
              ? "Loading projects..."
              : "Sally has not seen any project yet. A project appears here after its first check."}
          </p>
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
  onChange: (next: VersionView) => void;
  error: string | null;
  checkType: RuleDetail["checkType"];
  projects: Project[] | null;
}

function DraftForm({ value, onChange, error, checkType, projects }: DraftFormProps) {
  const setCondition = (index: number, text: string) =>
    onChange({
      ...value,
      conditions: value.conditions.map((c, i) => (i === index ? text : c)),
    });
  const removeCondition = (index: number) =>
    onChange({
      ...value,
      conditions: value.conditions.filter((_, i) => i !== index),
    });
  const addCondition = () =>
    onChange({ ...value, conditions: [...value.conditions, ""] });

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="draft-name">Name</FieldLabel>
        <Input
          id="draft-name"
          className="bg-background"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>Conditions</FieldLabel>
        <div className="space-y-2">
          {value.conditions.map((condition, index) => (
            <div key={index} className="flex items-start gap-2">
              <Input
                className="bg-background"
                aria-label={`Condition ${index + 1}`}
                value={condition}
                onChange={(e) => setCondition(index, e.target.value)}
                placeholder={
                  checkType === "message"
                    ? "The message asks for..."
                    : "The reply reports..."
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label={`Remove condition ${index + 1}`}
                onClick={() => removeCondition(index)}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addCondition}>
            <Plus />
            Add condition
          </Button>
        </div>
        <FieldDescription>
          The rule fires when any one condition holds. Write each as a short,
          concrete statement about the{" "}
          {checkType === "message" ? "user's message" : "final reply"}.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="draft-instruction">Instruction</FieldLabel>
        <Textarea
          id="draft-instruction"
          className="min-h-[140px] bg-background"
          value={value.instruction}
          onChange={(e) => onChange({ ...value, instruction: e.target.value })}
        />
        <FieldDescription>
          Claude receives this word for word. Worth having only when it is not
          already implied by the text that triggers it.
        </FieldDescription>
      </Field>
      <ScopeField
        value={value.scope}
        onChange={(scope) => onChange({ ...value, scope })}
        projects={projects}
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

export function RuleScreen({ id }: { id: number }) {
  const [rule, setRule] = React.useState<RuleDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<VersionView | null>(null);
  const [projects, setProjects] = React.useState<Project[] | null>(null);
  const [save, setSave] = React.useState<SaveState>({ kind: "idle" });
  const [publishing, setPublishing] = React.useState(false);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const latest = React.useRef<VersionView | null>(null);
  const inFlight = React.useRef<Promise<boolean>>(Promise.resolve(true));

  React.useEffect(() => {
    let stale = false;
    getRule(id)
      .then((loaded) => {
        if (stale) return;
        setRule(loaded);
        setDraft(contentOf(loaded));
      })
      .catch((e: unknown) => !stale && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [id]);

  React.useEffect(() => {
    let stale = false;
    listProjects()
      .then((loaded) => !stale && setProjects(loaded))
      // Without the list, the projects already in the scope still show.
      .catch(() => !stale && setProjects([]));
    return () => {
      stale = true;
    };
  }, []);

  /**
   * Saves the latest edits now; saves run one after another. Resolves to
   * whether the last save succeeded.
   */
  const flush = React.useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const content = latest.current;
    if (!content) return inFlight.current;
    latest.current = null;
    inFlight.current = inFlight.current.then(async () => {
      setSave({ kind: "saving" });
      try {
        const saved = await saveDraft(id, content);
        setRule(saved);
        setSave(latest.current ? { kind: "pending" } : { kind: "saved" });
        return true;
      } catch (e) {
        setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        return false;
      }
    });
    return inFlight.current;
  }, [id]);

  // Edits still waiting when the screen closes are saved straight away. When
  // the page itself goes (tab closed, reload), the save is sent at once with
  // keepalive so the browser lets it finish.
  React.useEffect(() => {
    const onPageHide = () => {
      const content = latest.current;
      if (!content) return;
      window.clearTimeout(timer.current);
      timer.current = undefined;
      latest.current = null;
      saveDraft(id, content, true).catch(() => undefined);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (latest.current) void flush();
    };
  }, [id, flush]);

  const edit = (next: VersionView) => {
    setDraft(next);
    setPublishError(null);
    latest.current = next;
    setSave({ kind: "pending" });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const doPublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      // A draft the server refused must not be published as the old draft.
      if (!(await flush())) return;
      const result = await publish(id);
      setRule(result.rule);
      // Edits typed while publishing stay in the form and are saved as the
      // next draft.
      if (!latest.current) {
        setDraft(contentOf(result.rule));
        setSave({ kind: "idle" });
      }
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

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

  const busy = save.kind === "pending" || save.kind === "saving";
  const canPublish = (rule.hasDraft || busy) && save.kind !== "error" && !publishing;

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
            ) : (
              <Badge variant="outline">Draft only</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <SaveStatus state={save} hasDraft={rule.hasDraft} />
          <Button onClick={doPublish} disabled={!canPublish}>
            {publishing ? <Loader2 className="animate-spin" /> : <Upload />}
            Publish
          </Button>
        </div>
      </div>
      {publishError && (
        <p role="alert" className="text-sm text-destructive">
          {publishError}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LiveVersion rule={rule} />
        <section className="rounded-md border">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="font-medium">Draft</h2>
            <span className="text-xs text-muted-foreground">
              {rule.hasDraft
                ? "Edits save automatically"
                : "Editing starts a draft"}
            </span>
          </div>
          <div className="px-4 py-4">
            <DraftForm
              value={draft}
              onChange={edit}
              checkType={rule.checkType}
              projects={projects}
              error={save.kind === "error" ? save.message : null}
            />
          </div>
        </section>
      </div>
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
