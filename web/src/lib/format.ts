/** A time as the screens show it: a medium date and a short time. */
export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A score from 0 to 1, to two places. */
export const formatScore = (score: number) => score.toFixed(2);
