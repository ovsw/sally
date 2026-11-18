// The fields of a rule's draft that every editor shares: its conditions and
// its instruction, and how far the draft is from being saved. Used by the
// Rule screen's draft form and by each proposed rule on the Import screen.
import { Check, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CheckType } from "@/lib/api";
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

interface ConditionsFieldProps {
  conditions: string[];
  checkType: CheckType;
  /** `field` names the condition being typed in; null for a change made in one step. */
  onChange: (conditions: string[], field: string | null) => void;
}

export function ConditionsField({ conditions, checkType, onChange }: ConditionsFieldProps) {
  return (
    <Field>
      <FieldLabel>Conditions</FieldLabel>
      <div className="space-y-2">
        {conditions.map((condition, index) => (
          <div key={index} className="flex items-start gap-2">
            <Input
              className="bg-background"
              aria-label={`Condition ${index + 1}`}
              value={condition}
              onChange={(e) =>
                onChange(
                  conditions.map((c, i) => (i === index ? e.target.value : c)),
                  `condition-${index}`,
                )
              }
              placeholder={checkType === "message" ? "The message asks for..." : "The reply reports..."}
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
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...conditions, ""], null)}>
          <Plus />
          Add condition
        </Button>
      </div>
      <FieldDescription>
        The rule matches when any one condition holds. Write each as a short, concrete statement about the{" "}
        {checkType === "message" ? "user's message" : "final reply"}.
      </FieldDescription>
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
      <FieldLabel htmlFor={id}>Instruction</FieldLabel>
      <Textarea
        id={id}
        className="min-h-[140px] bg-background"
        value={instruction}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldDescription>
        Claude receives this word for word. Worth having only when it is not already implied by the text that triggers
        it.
      </FieldDescription>
    </Field>
  );
}
