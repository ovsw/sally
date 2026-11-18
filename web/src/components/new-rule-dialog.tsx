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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type CheckType, createRule, type RuleDetail } from "@/lib/api";

type NewRule = { name: string; checkType: CheckType; instruction: string; conditions: string[] };

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
  const [checkType, setCheckType] = React.useState<CheckType>("message");
  const [condition, setCondition] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Each opening of the dialog is a session; a request finishing after its
  // session ended must not close or clear a later one.
  const session = React.useRef(0);

  const reset = () => {
    setName("");
    setCheckType("message");
    setCondition("");
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
        checkType,
        instruction,
        conditions: [condition],
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
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
              <div className="space-y-2">
                <LabelWithHelp htmlFor="new-rule-check" label="Type">
                  {ruleHelp.check}
                </LabelWithHelp>
                <Select
                  value={checkType}
                  onValueChange={(value) => setCheckType(value as CheckType)}
                >
                  <SelectTrigger id="new-rule-check" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="message">User message</SelectItem>
                    <SelectItem value="reply">Agent reply</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <LabelWithHelp htmlFor="new-rule-condition" label="Condition">
                {ruleHelp.condition(checkType)} You can add more after creating the rule.
              </LabelWithHelp>
              <Input
                id="new-rule-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                placeholder={
                  checkType === "message"
                    ? "e.g. The message asks for a visual change to a page."
                    : "e.g. The reply reports a finished visual change and gives no local link."
                }
              />
            </div>
            <div className="space-y-2">
              <LabelWithHelp htmlFor="new-rule-instruction" label="Instruction">
                {ruleHelp.instruction}
              </LabelWithHelp>
              <Textarea
                id="new-rule-instruction"
                className="min-h-[100px] resize-none"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={
                  checkType === "message"
                    ? "e.g. Before you open a pull request, give me the localhost link to the page and wait for my OK."
                    : "e.g. Add the localhost link to the page you changed."
                }
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
