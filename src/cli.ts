#!/usr/bin/env node
// The hook path: keep imports here limited to what the hooks need, so the
// command starts fast and never loads web app code.
import { runMessageHook } from "./message-hook.ts";
import { runReplyHook } from "./reply-hook.ts";

const hooks = { message: runMessageHook, reply: runReplyHook };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(args: string[]): Promise<number> {
  const [group, name] = args;
  if (group === "hook" && (name === "message" || name === "reply")) {
    try {
      const output = await hooks[name](await readStdin(), { env: process.env });
      if (output) process.stdout.write(output + "\n");
    } catch {
      // A hook never breaks the session.
    }
    return 0;
  }
  if (group === "app") {
    // Loaded only here, so the hooks never load web app code.
    const { runApp } = await import("./app/command.ts");
    await runApp(args.slice(1), process.env);
    return -1;
  }
  process.stderr.write("Usage: sally hook message|reply | sally app [--port N]\n");
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1: a server is running and keeps the process alive.
    if (code < 0) return;
    process.exitCode = code;
    // Do not wait for a request abandoned after the time limit.
    process.stdout.write("", () => process.exit(code));
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
