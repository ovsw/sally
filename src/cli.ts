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
  if (group === "sally-install" || group === "sally-uninstall") {
    // Loaded only here, so the hooks never pay for it.
    const { runInstall, runUninstall } = await import("./install-command.ts");
    const io = {
      env: process.env,
      stdout: (text: string) => process.stdout.write(text),
      stderr: (text: string) => process.stderr.write(text),
    };
    if (group === "sally-uninstall") return runUninstall(args.slice(1), io);
    return runInstall(args.slice(1), { ...io, isTerminal: process.stdin.isTTY === true });
  }
  // "wrong-match" is the command's old name, still printed in sessions started before the rename.
  if (group === "false-positive" || group === "wrong-match") {
    // Loaded only here, so the hooks never pay for it.
    const { runFalsePositive } = await import("./false-positive-command.ts");
    const result = runFalsePositive(args.slice(1), process.env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }
  if (group === "settings") {
    // Loaded only here, so the hooks never pay for it.
    const { runSettingsCommand } = await import("./settings-command.ts");
    const result = runSettingsCommand(args.slice(1), process.env);
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
  if (group === "import") {
    // Loaded only here, so the hooks never load any of the import.
    const { runImportCommand } = await import("./import-command.ts");
    return runImportCommand(args.slice(1), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      readStdin,
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
    [
      "Usage: node src/cli.ts sally-install [--yes]",
      "       node src/cli.ts sally-uninstall",
      "       node src/cli.ts app [--port N]",
      "       node src/cli.ts settings stop-on-failure [on|off]",
      '       node src/cli.ts false-positive "<rule name>"',
      "       node src/cli.ts rules list|show|create|edit",
      "       node src/cli.ts import start|add|show|list|backup|removed",
      "       node src/cli.ts evaluate FILE [--scale]",
      "       node src/cli.ts hook message|reply",
      "Run it in Sally's folder, or give the full path to src/cli.ts.",
      "",
    ].join("\n"),
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
