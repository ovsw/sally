import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Questions install asks the user in a terminal. */
export interface Prompt {
  /** Asks a question and returns the answer, echoed as it is typed. */
  ask(question: string): Promise<string>;
  /** Asks a question whose answer is not shown while it is typed, such as an API key. */
  askHidden(question: string): Promise<string>;
  close(): void;
}

/**
 * A prompt on the terminal. Hidden answers are read with echo switched off:
 * readline's own writes go through a gate that drops them while muted, so
 * neither the typed characters nor readline's line redraws reach the screen.
 */
export function terminalPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompt {
  let muted = false;
  const gate = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: gate, terminal: true });
  rl.on("SIGINT", () => {
    output.write("\n");
    process.exit(130);
  });
  const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve));
  return {
    ask: question,
    async askHidden(text) {
      output.write(text);
      muted = true;
      try {
        return await question("");
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    close: () => rl.close(),
  };
}
