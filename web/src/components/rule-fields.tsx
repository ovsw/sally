// The fields of a rule's draft that every editor shares: its name, its
// conditions with their Message and Reply switches, and its instruction, and
// how far the draft is from being saved. Used by the
// Rule screen's draft form and by each proposed rule on the Import screen.
import { Check, Loader2, Plus, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LabelWithHelp, ruleHelp } from "@/components/field-help";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ConditionDraft, RuleDetail, Switches } from "@/lib/api";
import type { SaveState } from "@/lib/draft-saver";

export function SaveStatus({ state, hasDraft }: { state: SaveState; hasDraft: boolean }) {
  const busy = state.kind === "pending" || state.kind === "saving";
  const text = busy
    ? "Saving..."
    : state.kind === "saved"
      ? "Draft saved"
      : state.kind === "error"
        ? "Not saved"
        : hasDraft
          ? "Draft saved"
          : "No draft";
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
      {busy ? (
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

/** The example a condition's field shows: one worded for the reply when only Reply is on. */
const conditionExample = (condition: ConditionDraft) =>
  condition.reply && !condition.message
    ? "e.g. The reply reports a finished visual change and gives no local link."
    : "e.g. The message asks for a visual change to a page.";

/** Which checks use a condition, as small badges; "Off" when neither does. */
export function ConditionChecks({ condition }: { condition: Switches }) {
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

/** The ids of the conditions in any of the rule's published versions: their switches are not the draft's to change. */
export function publishedConditionIds(rule: RuleDetail): Set<number> {
  return new Set(rule.versions.flatMap((version) => version.conditions.map((condition) => condition.id)));
}

interface ConditionSwitchProps {
  id: string;
  label: "Message" | "Reply";
  /** Names the condition for screen readers, since every condition has these two switches. */
  condition: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

function ConditionSwitch({ id, label, condition, checked, disabled, onChange }: ConditionSwitchProps) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={`${condition}: ${label}`}
      />
      <LabelWithHelp htmlFor={id} label={label} labelClassName="font-normal" about={`${label} switch`}>
        {label === "Message" ? ruleHelp.messageSwitch : ruleHelp.replySwitch}
        {disabled && <p>{ruleHelp.publishedSwitch}</p>}
      </LabelWithHelp>
    </div>
  );
}

interface ConditionsFieldProps {
  conditions: ConditionDraft[];
  /** The conditions already published: their switches show but do not change here. */
  published?: ReadonlySet<number>;
  /** `field` names the condition being typed in; null for a change made in one step. */
  onChange: (conditions: ConditionDraft[], field: string | null) => void;
}

export function ConditionsField({ conditions, published, onChange }: ConditionsFieldProps) {
  const labelId = React.useId();
  const idPrefix = React.useId();
  const change = (index: number, next: Partial<ConditionDraft>, field: string | null) =>
    onChange(
      conditions.map((c, i) => (i === index ? { ...c, ...next } : c)),
      field,
    );
  // A new condition starts with the switches of the one before it, or for the message.
  const last = conditions[conditions.length - 1];
  const added: ConditionDraft = { text: "", message: last?.message ?? true, reply: last?.reply ?? false };
  return (
    // Named by its label, since the group holds several inputs and "Add condition".
    <Field aria-labelledby={labelId}>
      <LabelWithHelp id={labelId} label="Conditions">
        {ruleHelp.condition}
      </LabelWithHelp>
      <div className="space-y-4">
        {conditions.map((condition, index) => {
          const name = `Condition ${index + 1}`;
          const fixed = condition.id !== undefined && (published?.has(condition.id) ?? false);
          return (
            <div key={index} className="space-y-2">
              <div className="flex items-start gap-2">
                <Input
                  className="bg-background"
                  aria-label={name}
                  value={condition.text}
                  onChange={(e) => change(index, { text: e.target.value }, `condition-${index}`)}
                  placeholder={conditionExample(condition)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={`Remove condition ${index + 1}`}
                  onClick={() => onChange(conditions.filter((_, i) => i !== index), null)}
                >
                  <X />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-1">
                <ConditionSwitch
                  id={`${idPrefix}-${index}-message`}
                  label="Message"
                  condition={name}
                  checked={condition.message}
                  disabled={fixed}
                  onChange={(message) => change(index, { message }, null)}
                />
                <ConditionSwitch
                  id={`${idPrefix}-${index}-reply`}
                  label="Reply"
                  condition={name}
                  checked={condition.reply}
                  disabled={fixed}
                  onChange={(reply) => change(index, { reply }, null)}
                />
              </div>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...conditions, added], null)}>
          <Plus />
          Add condition
        </Button>
      </div>
    </Field>
  );
}

interface NameFieldProps {
  id: string;
  name: string;
  onChange: (name: string) => void;
}

export function NameField({ id, name, onChange }: NameFieldProps) {
  return (
    <Field>
      <LabelWithHelp htmlFor={id} label="Name">
        {ruleHelp.name}
      </LabelWithHelp>
      <Input id={id} className="bg-background" value={name} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

interface InstructionFieldProps {
  id: string;
  instruction: string;
  onChange: (instruction: string) => void;
}

export function InstructionField({ id, instruction, onChange }: InstructionFieldProps) {
  return (
    <Field>
      <LabelWithHelp htmlFor={id} label="Instruction">
        {ruleHelp.instruction}
      </LabelWithHelp>
      <Textarea
        id={id}
        className="min-h-[140px] bg-background"
        value={instruction}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
