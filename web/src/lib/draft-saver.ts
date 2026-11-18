import * as React from "react";

import { type RuleDetail, saveDraft, type VersionView } from "@/lib/api";

// How a rule's draft is saved as the user types, wherever it is edited: the
// Rule screen and each proposed rule on the Import screen. Edits are saved
// after a short pause, one save after another; edits still waiting when the
// screen closes are saved straight away, and when the page itself goes (tab
// closed, reload) the save is sent at once with keepalive so the browser lets
// it finish.

const SAVE_DELAY_MS = 500;

export type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface DraftSaver {
  state: SaveState;
  setState: (state: SaveState) => void;
  /** Saves `content` into the draft after a pause; a later call replaces it. */
  saveSoon: (content: VersionView) => void;
  /** Saves the latest edits now. Resolves to whether the last save succeeded. */
  flush: () => Promise<boolean>;
  /**
   * Holds back edits not yet sent, waits for the saves already sent, then runs
   * `replace`, which replaces the draft. If `replace` fails, the held-back
   * edits are scheduled to save again, so the form and the draft still agree.
   */
  replacing: (replace: () => Promise<void>) => Promise<void>;
  /** Whether edits are waiting to be sent. */
  hasUnsent: () => boolean;
  /** Runs `run` in line with the saves, so a save answered earlier cannot undo what it shows. */
  inLine: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Saves the draft of rule `ruleId`, handing each saved rule to `onSaved`. */
export function useDraftSaver(ruleId: number, onSaved: (rule: RuleDetail) => void): DraftSaver {
  const [state, setState] = React.useState<SaveState>({ kind: "idle" });
  const timer = React.useRef<number | undefined>(undefined);
  const latest = React.useRef<VersionView | null>(null);
  const inFlight = React.useRef<Promise<boolean>>(Promise.resolve(true));
  const saved = React.useRef(onSaved);
  React.useEffect(() => {
    saved.current = onSaved;
  }, [onSaved]);

  const flush = React.useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const content = latest.current;
    if (!content) return inFlight.current;
    latest.current = null;
    inFlight.current = inFlight.current.then(async () => {
      setState({ kind: "saving" });
      try {
        saved.current(await saveDraft(ruleId, content));
        setState(latest.current ? { kind: "pending" } : { kind: "saved" });
        return true;
      } catch (e) {
        setState({ kind: "error", message: errorText(e) });
        return false;
      }
    });
    return inFlight.current;
  }, [ruleId]);

  const saveSoon = React.useCallback(
    (content: VersionView) => {
      latest.current = content;
      setState({ kind: "pending" });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const replacing = React.useCallback(
    async (replace: () => Promise<void>) => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      const held = latest.current;
      latest.current = null;
      await inFlight.current;
      try {
        await replace();
      } catch (e) {
        if (held && !latest.current) saveSoon(held);
        throw e;
      }
    },
    [saveSoon],
  );

  const hasUnsent = React.useCallback(() => latest.current !== null, []);

  const inLine = React.useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const before = inFlight.current;
    const result = before.then(run);
    inFlight.current = result.then(
      () => before,
      () => before,
    );
    return result;
  }, []);

  React.useEffect(() => {
    const onPageHide = () => {
      const content = latest.current;
      if (!content) return;
      window.clearTimeout(timer.current);
      timer.current = undefined;
      latest.current = null;
      saveDraft(ruleId, content, true).catch(() => undefined);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (latest.current) void flush();
    };
  }, [ruleId, flush]);

  return { state, setState, saveSoon, flush, replacing, hasUnsent, inLine };
}
