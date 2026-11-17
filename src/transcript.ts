import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const FIRST_CHUNK_BYTES = 256 * 1024;

interface Entry {
  type?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/**
 * The final assistant reply in a Claude Code session transcript (JSON lines):
 * the text blocks of the assistant entries after the last user entry. Only
 * text is taken, never reasoning or tool calls; tool results are user entries,
 * so they end the search. Reads from the end of the file, so a long
 * transcript costs little. Undefined when there is no reply text.
 */
export function finalReplyFromTranscript(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let chunk = FIRST_CHUNK_BYTES; ; chunk *= 4) {
      const start = Math.max(0, size - chunk);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      // The first line of a chunk that starts mid-file may be cut; drop it.
      if (start > 0) lines.shift();
      const { texts, reachedUser } = scanBackwards(lines);
      if (reachedUser || start === 0) {
        const reply = texts.join("\n\n");
        return reply.trim() ? reply : undefined;
      }
    }
  } finally {
    closeSync(fd);
  }
}

function scanBackwards(lines: string[]): { texts: string[]; reachedUser: boolean } {
  const texts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (entry.type === "user") return { texts, reachedUser: true };
    if (entry.type !== "assistant") continue;
    texts.unshift(...textBlocks(entry.message?.content));
  }
  return { texts, reachedUser: false };
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
}
