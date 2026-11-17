#!/usr/bin/env node
// The hook path: keep imports here limited to what the hooks need, so the
// command starts fast and never loads web app code.
import { runMessageHook } from "./message-hook.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(args: string[]): Promise<number> {
  const [group, name] = args;
  if (group === "hook" && name === "message") {
    try {
      const output = await runMessageHook(await readStdin(), { env: process.env });
      if (output) process.stdout.write(output + "\n");
    } catch {
      // A hook never breaks the session.
    }
    return 0;
  }
  process.stderr.write("Usage: sally hook message\n");
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  // Do not wait for a request abandoned after the time limit.
  process.stdout.write("", () => process.exit(code));
});
