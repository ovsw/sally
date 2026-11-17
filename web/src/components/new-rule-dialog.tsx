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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type CheckType, createRule, type RuleDetail } from "@/lib/api";

interface NewRuleDialogProps {
  onCreated: (rule: RuleDetail) => void;
}

export function NewRuleDialog({ onCreated }: NewRuleDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [checkType, setCheckType] = React.useState<CheckType>("message");
  const [condition, setCondition] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setName("");
    setCheckType("message");
    setCondition("");
    setInstruction("");
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const rule = await createRule({
        name,
        checkType,
        instruction,
        conditions: [condition],
      });
      setOpen(false);
      reset();
      onCreated(rule);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="h-8">
          <Plus />
          New rule
        </Button>
      </DialogTrigger>
      <DialogContent className="p-0 sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle>New rule</DialogTitle>
            <DialogDescription>
              The rule starts as a draft. It is not live until you publish it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 pt-6 pb-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
              <div className="space-y-2">
                <Label htmlFor="new-rule-name">Name</Label>
                <Input
                  id="new-rule-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Local link before a PR"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-rule-check">Check</Label>
                <Select
                  value={checkType}
                  onValueChange={(value) => setCheckType(value as CheckType)}
                >
                  <SelectTrigger id="new-rule-check" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="message">Message check</SelectItem>
                    <SelectItem value="reply">Reply check</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-rule-condition">Condition</Label>
              <Input
                id="new-rule-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                placeholder={
                  checkType === "message"
                    ? "The message asks for a visual change to a page."
                    : "The reply reports a finished visual change and gives no local link."
                }
              />
              <p className="text-xs text-muted-foreground">
                A short statement that is true or false of the{" "}
                {checkType === "message" ? "user's message" : "final reply"}.
                You can add more conditions after creating the rule.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-rule-instruction">Instruction</Label>
              <Textarea
                id="new-rule-instruction"
                className="min-h-[100px] resize-none"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="What Claude should do, word for word."
              />
              <p className="text-xs text-muted-foreground">
                Worth writing only if the instruction is not already implied by
                the text that triggers it.
              </p>
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
