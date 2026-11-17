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
  if ((group === "install" || group === "uninstall") && name === undefined) {
    // Loaded only here, so the hooks never pay for it.
    const setup = await import("./install.ts");
    try {
      const { changes } = setup[group]({ env: process.env });
      const done = group === "install" ? "Sally is already installed." : "Sally is not installed.";
      process.stdout.write((changes.length > 0 ? changes.join("\n") : done) + "\n");
      return 0;
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      return 1;
    }
  }
  if (group === "wrong-match") {
    // Loaded only here, so the hooks never pay for it.
    const { runWrongMatch } = await import("./wrong-match.ts");
    const result = runWrongMatch(args.slice(1), process.env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }
  if (group === "app") {
    // Loaded only here, so the hooks never load web app code.
    const { runApp } = await import("./app/command.ts");
    await runApp(args.slice(1), process.env);
    return -1;
  }
  if (group === "rules") {
    // Loaded only here, so the hooks stay as small as they are.
    const { runRulesCommand } = await import("./rules-command.ts");
    return runRulesCommand(args.slice(1), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
  if (group === "evaluate") {
    // Loaded only here: the evaluation calls the real Jev and runs only on request.
    const { runEvaluation } = await import("./evaluate.ts");
    return runEvaluation(args.slice(1), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
  process.stderr.write(
    'Usage: sally hook message|reply\n       sally install\n       sally uninstall\n       sally rules list|show|create|edit\n       sally app [--port N]\n       sally wrong-match "<rule name>"\n       sally evaluate FILE [--scale]\n',
  );
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
