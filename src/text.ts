/** What an email address becomes before anything is sent to the matcher. */
export const EMAIL_MASK = "[email]";

/**
 * An email address: an unquoted or quoted local part, then a named domain or
 * an address literal such as `[192.0.2.1]`. The lookbehind lets an unquoted
 * local part start only at the beginning of a run of allowed characters, so a
 * long run without `@` is scanned once instead of once per character.
 */
const EMAIL =
  /(?:"[^"\r\n]*"|(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+)@(?:\[[^\]\s]+\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})/gu;

/** Replaces every email address in the text, so contact details never leave the machine. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, EMAIL_MASK);
}

/**
 * A leading slash command: `/name` at the very start, where a name may hold
 * letters, digits, `-`, `_`, `.` and `:` (as in `plugin:skill`), followed by
 * whitespace or the end. A path such as `/home/me` is not a command.
 */
const SLASH_COMMAND = /^\s*\/[\p{L}\p{N}_][\p{L}\p{N}_.:-]*(?=\s|$)/u;

/** The fewest words that must follow a slash command for the message to be checked. */
export const MIN_WORDS_AFTER_COMMAND = 3;

export type MessageText = { kind: "check"; text: string } | { kind: "skip" };

/**
 * The part of a user's message the message check judges. A message that
 * starts with a slash command is judged only on the text after the command
 * name, and skipped when nothing meaningful follows it: a bare command, or a
 * command with only short arguments.
 */
export function messageText(message: string): MessageText {
  const command = SLASH_COMMAND.exec(message);
  if (!command) return { kind: "check", text: message };
  const rest = message.slice(command[0].length).trim();
  const words = rest.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.length >= MIN_WORDS_AFTER_COMMAND ? { kind: "check", text: rest } : { kind: "skip" };
}

/**
 * Text pasted into a message, as T3 Code marks it: `<pasted_content id="x">`
 * up to the closing tag with the same id, or plain `<pasted_content>` tags.
 * Plain Claude Code marks nothing, so its pastes are not found.
 */
const PASTE =
  /<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content id="\1">|<pasted_content>([\s\S]*?)<\/pasted_content>/g;

/** What a paste becomes before the message is checked. */
export function pasteNote(lines: number): string {
  return `[pasted text left out: ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}]`;
}

/**
 * The message with each marked paste replaced by a short note, so a rule is
 * checked against what the user wrote, not against a document, log or
 * transcript they pasted. A paste whose closing tag is missing is left in.
 */
export function leaveOutPastes(message: string): { text: string; pastes: number } {
  let pastes = 0;
  const text = message.replace(PASTE, (_, _id, withId: string | undefined, bare: string | undefined) => {
    pastes++;
    const body = (withId ?? bare ?? "").trim();
    return pasteNote(body === "" ? 0 : body.split(/\r\n|\r|\n/).length);
  });
  return { text, pastes };
}
