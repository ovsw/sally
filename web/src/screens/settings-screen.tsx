// The Settings screen, built on the shadcnblocks block form-layouts-7
// (spacious form with sections): matching, the attention thresholds, and how
// much of Jev's request limit recent checks have used.
import { Check, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  getSettings,
  type LimitUse,
  type Settings,
  updateSettings,
} from "@/lib/api";

type Key = keyof Settings;

/** One setting's field. A share is shown as a percentage and stored from 0 to 1. */
interface FieldSpec {
  key: Key;
  label: string;
  description: string;
  step: string;
  min: string;
  max?: string;
  unit?: string;
  percent?: boolean;
}

const matching: FieldSpec[] = [
  {
    key: "cutoff",
    label: "Cutoff",
    description:
      "The score, from 0 to 1, a condition must reach for its rule to fire.",
    step: "0.01",
    min: "0",
    max: "1",
  },
  {
    key: "cap",
    label: "Cap",
    description:
      "The most rules attached in one check. The weakest matches are dropped first.",
    step: "1",
    min: "1",
  },
  {
    key: "timeLimitMs",
    label: "Time limit",
    description:
      "How long a check waits for Jev before letting the turn through unchanged.",
    step: "1",
    min: "1",
    unit: "ms",
  },
];

const attention: FieldSpec[] = [
  {
    key: "recentChecks",
    label: "Recent checks",
    description:
      "How many of the latest checks count as recent, for the firing share and for the request size below.",
    step: "1",
    min: "1",
    unit: "checks",
  },
  {
    key: "busyShare",
    label: "Fires often",
    description:
      "A rule firing on at least this share of recent checks needs attention.",
    step: "1",
    min: "1",
    max: "100",
    unit: "%",
    percent: true,
  },
  {
    key: "closeMargin",
    label: "Close to the cutoff",
    description:
      "Firing scores no more than this above the cutoff count as weak matches.",
    step: "0.01",
    min: "0",
    max: "1",
  },
  {
    key: "quietChecks",
    label: "Never fires",
    description:
      "A rule with no firings over this many checks of its type needs attention.",
    step: "1",
    min: "1",
    unit: "checks",
  },
];

const allFields = [...matching, ...attention];

type FormValues = Record<Key, string>;

const toForm = (settings: Settings): FormValues =>
  Object.fromEntries(
    allFields.map((f) => [
      f.key,
      String(
        f.percent
          ? Number((settings[f.key] * 100).toFixed(2))
          : settings[f.key],
      ),
    ]),
  ) as FormValues;

/** The settings the form changes, or the first field that is not a number. */
function changesFrom(
  form: FormValues,
  saved: Settings,
): { changes: Partial<Settings> } | { invalid: FieldSpec } {
  const changes: Partial<Settings> = {};
  const baseline = toForm(saved);
  for (const f of allFields) {
    const text = form[f.key].trim();
    // An untouched field keeps its stored value exactly, unrounded.
    if (text === baseline[f.key].trim()) continue;
    const number = Number(text);
    if (text === "" || !Number.isFinite(number)) return { invalid: f };
    const value = f.percent ? number / 100 : number;
    if (value !== saved[f.key]) changes[f.key] = value;
  }
  return { changes };
}

const formatTokens = (n: number) => n.toLocaleString("en-US");
const formatShare = (share: number) => `${Math.round(share * 100)}%`;

function LimitUseSection({ use }: { use: LimitUse }) {
  const limit = formatTokens(use.requestLimit);
  return (
    <FieldSet>
      <FieldLegend>Jev request size</FieldLegend>
      <FieldDescription>
        Jev takes at most {limit} tokens in one request, for the text and all
        its conditions. When the conditions no longer fit, they are split across
        parallel requests.
      </FieldDescription>
      {use.largestRequest === null || use.share === null ? (
        <p className="text-sm text-muted-foreground">
          No recent check has reported its size yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="font-medium">
              {formatShare(use.share)} of the limit
            </span>
            <span className="text-muted-foreground">
              {formatTokens(use.largestRequest)} / {limit} tokens
            </span>
          </div>
          <Progress
            value={Math.min(100, use.share * 100)}
            aria-label="Share of Jev's request limit in use"
            className={use.warning ? "h-2 *:bg-destructive" : "h-2"}
          />
          <p className="text-sm text-muted-foreground">
            The largest request among the last{" "}
            {use.checks === 1 ? "check" : `${use.checks} checks`} that reported
            a size.
          </p>
          {use.warning && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                Requests are past {formatShare(use.warningShare)} of Jev's
                limit
              </AlertTitle>
              <AlertDescription>
                Checks will soon be split across more than one request each.
                Fewer or shorter conditions keep them in one.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </FieldSet>
  );
}

function SettingField({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `setting-${spec.key}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{spec.label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          className="w-32 bg-background"
          step={spec.step}
          min={spec.min}
          max={spec.max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {spec.unit && (
          <span className="text-sm text-muted-foreground">{spec.unit}</span>
        )}
      </div>
      <FieldDescription>{spec.description}</FieldDescription>
    </Field>
  );
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function SettingsScreen() {
  const [saved, setSaved] = React.useState<Settings | null>(null);
  const [use, setUse] = React.useState<LimitUse | null>(null);
  const [form, setForm] = React.useState<FormValues | null>(null);
  const [state, setState] = React.useState<SaveState>({ kind: "idle" });
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stale = false;
    getSettings()
      .then((answer) => {
        if (stale) return;
        setSaved(answer.settings);
        setUse(answer.limitUse);
        setForm(toForm(answer.settings));
      })
      .catch((error: Error) => !stale && setLoadError(error.message));
    return () => {
      stale = true;
    };
  }, []);

  const result = form && saved ? changesFrom(form, saved) : null;
  const dirty =
    result !== null &&
    ("invalid" in result || Object.keys(result.changes).length > 0);

  const change = (key: Key) => (value: string) => {
    setForm((current) => current && { ...current, [key]: value });
    setState({ kind: "idle" });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!result || state.kind === "saving") return;
    if ("invalid" in result) {
      setState({
        kind: "error",
        message: `${result.invalid.label} must be a number.`,
      });
      return;
    }
    setState({ kind: "saving" });
    try {
      const answer = await updateSettings(result.changes);
      setSaved(answer.settings);
      setUse(answer.limitUse);
      setForm(toForm(answer.settings));
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  }

  return (
    <div className="w-full">
      <div className="mb-6 text-left">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Tune the engine. Saved changes apply from the next check.
        </p>
      </div>
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      {form && use && (
        <div className="w-full max-w-2xl">
          {/* The server checks each value and says what is wrong. */}
          <form className="space-y-8" onSubmit={save} noValidate>
            {/* Locked while a save is pending, so no edit is lost to its answer. */}
            <fieldset
              className="space-y-8"
              disabled={state.kind === "saving"}
            >
              <FieldSet>
                <FieldLegend>Matching</FieldLegend>
                <FieldDescription>
                  When a rule fires, and how long a check may take.
                </FieldDescription>
                <FieldGroup className="gap-6">
                  {matching.map((spec) => (
                    <SettingField
                      key={spec.key}
                      spec={spec}
                      value={form[spec.key]}
                      onChange={change(spec.key)}
                    />
                  ))}
                </FieldGroup>
              </FieldSet>
              <FieldSet>
                <FieldLegend>Needs attention</FieldLegend>
                <FieldDescription>
                  When a rule is listed as needing attention.
                </FieldDescription>
                <FieldGroup className="gap-6">
                  {attention.map((spec) => (
                    <SettingField
                      key={spec.key}
                      spec={spec}
                      value={form[spec.key]}
                      onChange={change(spec.key)}
                    />
                  ))}
                </FieldGroup>
              </FieldSet>
            </fieldset>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!dirty || state.kind === "saving"}>
                {state.kind === "saving" && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Save changes
              </Button>
              <span aria-live="polite" className="text-sm">
                {state.kind === "saved" && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Check className="size-4" />
                    Saved
                  </span>
                )}
                {state.kind === "error" && (
                  <span role="alert" className="text-destructive">
                    {state.message}
                  </span>
                )}
              </span>
            </div>
          </form>
          <div className="mt-10">
            <LimitUseSection use={use} />
          </div>
        </div>
      )}
    </div>
  );
}
