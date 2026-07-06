#!/usr/bin/env bun
// foreman — entrypoint and CLI.
//
//   foreman supervise                         run the agent supervisor (default)
//   foreman secret set NAME                    read a value from stdin, store it encrypted
//   foreman run --secret NAME[,NAME] -- cmd…   run cmd with the named secret(s) injected as env
//
// Designed to be spawned by keeper.sh, which restarts it on exit.

import { loadConfig } from "./config.ts";
import { runWithSecrets, secretSetFromStdin } from "./secrets.ts";
import { supervise } from "./supervisor.ts";

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const [cmd, ...rest] = argv;

  switch (cmd ?? "supervise") {
    case "supervise":
      await supervise(cfg);
      return 0;

    case "secret": {
      if (rest[0] !== "set" || !rest[1]) {
        console.error("usage: foreman secret set NAME   (value is read from stdin)");
        return 2;
      }
      await secretSetFromStdin(cfg, rest[1]);
      return 0;
    }

    case "run": {
      const { names, command } = parseRun(rest);
      if (names.length === 0 || command.length === 0) {
        console.error("usage: foreman run --secret NAME[,NAME] -- cmd [args…]");
        return 2;
      }
      return await runWithSecrets(cfg, names, command);
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.error("commands: supervise | secret set NAME | run --secret NAME -- cmd");
      return 2;
  }
}

function parseRun(args: string[]): { names: string[]; command: string[] } {
  const names: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    const next = args[i + 1];
    if (a === "--secret" && next) {
      i++;
      names.push(
        ...next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      // unknown token before `--`: treat as malformed
      return { names, command: [] };
    }
  }
  return { names, command: args.slice(i) };
}

process.exit(await main(process.argv.slice(2)));
