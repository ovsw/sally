/** A time as the screens show it: a medium date and a short time. */
export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A score from 0 to 1, to two places. */
export const formatScore = (score: number) => score.toFixed(2);

/** What each check type is called on the screens. */
export const CHECK_LABELS = { message: "User message", reply: "Agent reply" } as const;

/** The checks a rule takes part in, in words: "User message", "Agent reply", both, or none. */
export function checkTypesText(checkTypes: ("message" | "reply")[]): string {
  if (checkTypes.length === 0) return "No check";
  if (checkTypes.length === 2) return "User message and agent reply";
  return CHECK_LABELS[checkTypes[0]!];
}

/** The check types these conditions are on for, message first. */
export const checkTypesOf = (conditions: { message: boolean; reply: boolean }[]) =>
  (["message", "reply"] as const).filter((type) => conditions.some((condition) => condition[type]));
