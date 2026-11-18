// A field's label with an information mark beside it. Hovering or focusing the
// mark explains what the field is for. Explanations live here and never in a
// placeholder: a placeholder holds only an example, marked "e.g.".
import { Info } from "lucide-react";
import type * as React from "react";

import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LabelWithHelpProps {
  /** The id of the control the label names; omit for a group of controls. */
  htmlFor?: string;
  label: string;
  children: React.ReactNode;
}

export function LabelWithHelp({ htmlFor, label, children }: LabelWithHelpProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${label.toLowerCase()}`}
            className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {/* One block: the tooltip lays its direct children out in a row. */}
          <div className="space-y-1.5 text-pretty">{children}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** What each field of a rule is for, shared by every place a rule is written. */
export const ruleHelp = {
  name: "A short label for the rule. Claude sees it with the instruction, and you use it to find the rule. No two rules share a name.",
  check: (
    <>
      <p>When Sally checks this rule.</p>
      <p>
        <strong>Message check:</strong> against your message, before Claude starts work. On a match, the instruction
        goes to Claude with your message.
      </p>
      <p>
        <strong>Reply check:</strong> against Claude's final reply. On a match, the reply is sent back to Claude once,
        with the instruction.
      </p>
    </>
  ),
  condition: (checkType: "message" | "reply") =>
    `A short, concrete statement that is true or false of the ${
      checkType === "message" ? "user's message" : "final reply"
    }. The rule matches when a condition holds. A rule can have several; any one is enough.`,
  scope:
    "Where the rule applies: all projects, or only the ones you pick. A project is a git repository, named by its remote, so every worktree of it counts as one project. A rule is never checked outside its scope.",
  instruction:
    "What Claude should do when the rule matches. Claude receives it word for word and has not seen it before. Leave out what the message or reply already makes obvious.",
};
