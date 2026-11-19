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
  /** The label's own id, for a group of controls to be named by it. */
  id?: string;
  label: string;
  /** What the information mark is about, when the label alone does not say; the label by default. */
  about?: string;
  /** Classes for the label, such as a lighter weight beside a switch. */
  labelClassName?: string;
  children: React.ReactNode;
}

export function LabelWithHelp({ htmlFor, id, label, about = label, labelClassName, children }: LabelWithHelpProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor} id={id} className={labelClassName}>
        {label}
      </Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${about.toLowerCase()}`}
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

/** A table column's header with the same information mark, for a column whose meaning is not obvious. */
export function HeaderWithHelp({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${title.toLowerCase()}`}
            className="rounded-full font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1.5 text-pretty">{children}</div>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** What each field of a rule is for, shared by every place a rule is written. */
export const ruleHelp = {
  name: "A short label for the rule. Claude sees it with the instruction, and you use it to find the rule. No two rules share a name.",
  condition:
    "A short, concrete statement that is true or false of the text being checked. The rule matches when a condition holds. A rule can have several; any one is enough. Its Message and Reply switches say which checks use it.",
  /** The Message switch of a condition. */
  messageSwitch: (
    <>
      <p>
        <strong>Message on:</strong> Sally checks this condition against your message, before Claude starts work. On a
        match, the instruction goes to Claude with your message.
      </p>
      <p>With Message and Reply both off, the condition is off and is not checked.</p>
    </>
  ),
  /** The Reply switch of a condition. */
  replySwitch: (
    <>
      <p>
        <strong>Reply on:</strong> Sally checks this condition against Claude's final reply. On a match, the reply is sent
        back to Claude once, with the instruction.
      </p>
      <p>With Message and Reply both off, the condition is off and is not checked.</p>
    </>
  ),
  /** Said beside the switches of a published condition, which a draft does not change. */
  publishedSwitch: "This condition is published, so it keeps these switches when you change its wording.",
  scope:
    "Where the rule applies: all projects, or only the ones you pick. A project is a git repository, named by its remote, so every worktree of it counts as one project. A rule is never checked outside its scope. A change takes effect at once and is not part of the draft.",
  instruction:
    "What Claude should do when the rule matches. Claude receives it word for word and has not seen it before. Leave out what the message or reply already makes obvious.",
};
