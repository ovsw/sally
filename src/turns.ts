import type { Store } from "./store.ts";

const now = () => new Date().toISOString();

/**
 * Records Claude's final reply for a turn, tied to the turn's message check:
 * the session's latest message check, unless an earlier turn already holds it.
 * An older message check is never used: its turn ended without a reply.
 */
export function recordReply(
  store: Store,
  turn: { sessionId: string | undefined; reply: string; replyCheckId: number | undefined },
): void {
  let messageCheckId: number | null = null;
  if (turn.sessionId !== undefined) {
    const row = store
      .prepare(
        `SELECT id FROM (SELECT id FROM checks
                          WHERE check_type = 'message' AND session_id = ?
                          ORDER BY id DESC LIMIT 1)
          WHERE id NOT IN (SELECT message_check_id FROM turns
                            WHERE session_id = ? AND message_check_id IS NOT NULL)`,
      )
      .get(turn.sessionId, turn.sessionId) as { id: number } | undefined;
    messageCheckId = row?.id ?? null;
  }
  store
    .prepare(
      `INSERT INTO turns (created_at, session_id, message_check_id, reply_check_id, reply)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(now(), turn.sessionId ?? null, messageCheckId, turn.replyCheckId ?? null, turn.reply);
}

/** Records the reply Claude gave after a send-back, beside the original on the session's latest turn. */
export function recordRevisedReply(store: Store, turn: { sessionId: string | undefined; reply: string }): void {
  if (turn.sessionId === undefined) return;
  store
    .prepare(
      `UPDATE turns SET revised_reply = ?, revised_at = ?
        WHERE id = (SELECT MAX(id) FROM turns WHERE session_id = ?)`,
    )
    .run(turn.reply, now(), turn.sessionId);
}
