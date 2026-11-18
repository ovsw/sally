import * as React from "react";

import type { RuleDetail } from "@/lib/api";

// The rules list and the open rule's panel show the same rules side by side.
// Whoever changes a rule says so here, and the other one catches up: the list
// reloads, and the panel takes the new on or off.

/** A rule as the server answered after a change, or the id of a deleted rule. */
export type RuleChange = { rule: RuleDetail } | { deleted: number };

const changes = new EventTarget();

export function announceRuleChange(change: RuleChange): void {
  changes.dispatchEvent(new CustomEvent<RuleChange>("change", { detail: change }));
}

export function useRuleChanges(onChange: (change: RuleChange) => void): void {
  const latest = React.useRef(onChange);
  React.useEffect(() => {
    latest.current = onChange;
  });
  React.useEffect(() => {
    const listener = (event: Event) => latest.current((event as CustomEvent<RuleChange>).detail);
    changes.addEventListener("change", listener);
    return () => changes.removeEventListener("change", listener);
  }, []);
}
