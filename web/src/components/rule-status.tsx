// A rule's publishing status, the way Sanity shows a document's: a green light
// when it has a published version, a yellow one when it has a draft. A rule
// can have both. Whether it is on or off is shown apart from this.
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PUBLISHED = { label: "Published", hint: "Has a published version", dot: "bg-emerald-500" };
const DRAFT = { label: "Draft", hint: "Has an unpublished draft", dot: "bg-amber-400" };

type Status = { published: boolean; hasDraft: boolean };

function shown({ published, hasDraft }: Status) {
  return [published && PUBLISHED, hasDraft && DRAFT].filter((s) => s !== false);
}

/** Labelled pills, for the rule panel. */
export function RuleStatus(status: Status) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {shown(status).map((s) => (
        <Badge key={s.label} variant="outline" className="gap-1.5 whitespace-nowrap">
          <span aria-hidden className={`size-2 rounded-full ${s.dot}`} />
          {s.label}
        </Badge>
      ))}
    </span>
  );
}

/** Lights only, each saying what it means on hover, for the rules list. */
export function RuleLights(status: Status) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {shown(status).map((s) => (
        <Tooltip key={s.label}>
          <TooltipTrigger asChild>
            <span role="img" aria-label={s.hint} className="flex size-4 items-center justify-center">
              <span className={`size-2 rounded-full ${s.dot}`} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{s.hint}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}
