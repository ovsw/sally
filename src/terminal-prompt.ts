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
  // No history: a hidden answer must not come back with the Up key at a later question.
  const rl = createInterface({ input, output: gate, terminal: true, historySize: 0 });
  rl.on("SIGINT", () => {
    output.write("\n");
    process.exit(130);
  });
  // Input that ends before an answer (Ctrl-D, a closed pipe) fails the question instead of hanging.
  const question = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const closed = () => reject(new Error("Input ended before the question was answered."));
      rl.once("close", closed);
      rl.question(text, (answer) => {
        rl.off("close", closed);
        resolve(answer);
      });
    });
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
