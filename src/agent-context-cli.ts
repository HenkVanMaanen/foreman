import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boundedText, notesContext, reviewContext } from "./agent-context.ts";

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "notes-context") {
    if (args.length) throw new Error("notes-context takes no arguments");
    process.stdout.write(notesContext(process.env["FOREMAN_NOTES_DIR"] || "notes"));
  } else if (mode === "review-context") {
    const [cwd, base, directory] = args;
    if (args.length !== 3 || !cwd || !base || !directory)
      throw new Error("review-context needs worktree, base, artifact directory");
    process.stdout.write(reviewContext(cwd, base, directory));
  } else if (mode === "bounded-run") {
    if (args[0] !== "--" || args.length < 2) throw new Error("bounded-run -- command [args...]");
    const directory = resolve(process.env["FOREMAN_STATE_DIR"] || "state", "tool-results");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const artifact = join(directory, `${Date.now()}-${randomUUID()}.log`);
    const fd = openSync(artifact, "wx", 0o600);
    let first = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let bytes = 0;
    let binary = false;
    let code = 1;
    try {
      const child = Bun.spawn(args.slice(1), { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
      await Promise.all(
        [child.stdout, child.stderr].map(async (stream) => {
          for await (const chunk of stream) {
            bytes += chunk.length;
            binary ||= chunk.includes(0);
            if (first.length < 10_000)
              first = Buffer.concat([first, chunk.subarray(0, 10_000 - first.length)]);
            tail = Buffer.concat([tail, chunk.subarray(-10_000)]).subarray(-10_000);
            writeFileSync(fd, chunk);
          }
        }),
      );
      code = await child.exited;
    } finally {
      closeSync(fd);
    }
    if (binary) {
      console.log(`Binary result: ${bytes} bytes; full artifact: ${artifact}; exit=${code}`);
    } else {
      process.stdout.write(
        boundedText(
          (bytes <= 10_000 ? first : Buffer.concat([first, tail])).toString(),
          10_000,
          `Full artifact: ${artifact}; exit=${code}`,
          bytes,
        ),
      );
    }
    process.exitCode = code;
  } else {
    throw new Error("unknown context command");
  }
} catch (error) {
  console.error(`agent-context: ${error instanceof Error ? error.message : "command failed"}`);
  process.exitCode = 1;
}
