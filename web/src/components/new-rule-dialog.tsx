// Adapted from the shadcnblocks block dialog-standard-16 (edit profile dialog).
import { Plus } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LabelWithHelp, ruleHelp } from "@/components/field-help";
import { ConditionsField } from "@/components/rule-fields";
import { Textarea } from "@/components/ui/textarea";
import { type ConditionDraft, createRule, type NewRule as RuleToCreate, type RuleDetail } from "@/lib/api";

type NewRule = Omit<RuleToCreate, "scope">;

/** The one empty condition a new rule starts with, on for the message. */
const firstCondition = (): ConditionDraft[] => [{ text: "", message: true, reply: false }];

interface NewRuleDialogProps<T> {
  onCreated: (created: T) => void;
  /** The button that opens the dialog; a small "New rule" button by default. */
  trigger?: React.ReactNode;
  /** Creates the rule; a plain new rule by default. */
  create?: (rule: NewRule) => Promise<T>;
  title?: string;
  description?: string;
}

export function NewRuleDialog<T = RuleDetail>({
  onCreated,
  trigger,
  create = createRule as unknown as (rule: NewRule) => Promise<T>,
  title = "New rule",
  description = "The rule starts as a draft. Checks do not use it until you publish it.",
}: NewRuleDialogProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [conditions, setConditions] = React.useState<ConditionDraft[]>(firstCondition);
  const [instruction, setInstruction] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Each opening of the dialog is a session; a request finishing after its
  // session ended must not close or clear a later one.
  const session = React.useRef(0);

  const reset = () => {
    setName("");
    setConditions(firstCondition());
    setInstruction("");
    setError(null);
    setBusy(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const mine = session.current;
    setBusy(true);
    setError(null);
    try {
      const rule = await create({
        name,
        instruction,
        conditions: conditions.map(({ text, message, reply }) => ({ text, message, reply })),
      });
      if (session.current === mine) {
        session.current += 1;
        setOpen(false);
        reset();
      }
      onCreated(rule);
    } catch (e) {
      if (session.current === mine) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (session.current === mine) setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          session.current += 1;
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" className="h-8">
            <Plus />
            New rule
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 pt-6 pb-6">
            <div className="space-y-2">
              <LabelWithHelp htmlFor="new-rule-name" label="Name">
                {ruleHelp.name}
              </LabelWithHelp>
              <Input
                id="new-rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Local link before a PR"
                autoFocus
              />
            </div>
            <ConditionsField conditions={conditions} onChange={(next) => setConditions(next)} />
            <div className="space-y-2">
              <LabelWithHelp htmlFor="new-rule-instruction" label="Instruction">
                {ruleHelp.instruction}
              </LabelWithHelp>
              <Textarea
                id="new-rule-instruction"
                className="min-h-[100px] resize-none"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. Before you open a pull request, give me the localhost link to the page and wait for my OK."
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="m-0 px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
