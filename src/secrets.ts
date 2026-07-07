// Encrypted secret store + the two primitives that keep secret *values* out of the
// agent's context:
//   - `foreman secret set NAME`   : reads the value from STDIN, encrypts, stores.
//   - `foreman run --secret NAME -- cmd` : decrypts, injects into the child env only, execs.
//
// Encryption is delegated to `age` (https://age-encryption.org) — a small, audited,
// single-purpose tool. We use recipient (X25519) mode, not passphrase mode, on purpose:
//   - encrypting (`secret set`) needs only the PUBLIC recipient, so capture stays fully
//     non-interactive and pipe-friendly (`wait-reply --raw | foreman secret set X`);
//   - decrypting (`run --secret`) needs the private identity file — the one root secret.
//
// The agent references secrets by NAME. A value only ever lives in: this store (encrypted
// at rest), a pipe during capture, and a child process's env during use — never in the
// model's transcript, notes, or logs.

import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";

/** Validate a caller-supplied secret NAME and derive its on-disk filename. The guard keeps a
 *  name from escaping the secrets dir (no `/`, `..`, etc.) — anything but UPPER_SNAKE_CASE is
 *  rejected. Exported as a pure function so it can be unit-tested without a store/filesystem. */
export function secretFileName(name: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid secret name: ${name} (use UPPER_SNAKE_CASE)`);
  }
  return `${name}.age`;
}

export class SecretsStore {
  private dir: string;

  constructor(private cfg: Config) {
    this.dir = join(cfg.stateDir, "secrets");
  }

  private path(name: string): string {
    return join(this.dir, secretFileName(name));
  }

  /** The public recipient to encrypt to: explicit if configured, else derived from the identity. */
  private recipient(): string {
    if (this.cfg.ageRecipient) return this.cfg.ageRecipient;
    const id = resolve(this.cfg.ageIdentityFile);
    if (!existsSync(id)) {
      throw new Error(
        `age identity not found at ${id}; set FOREMAN_AGE_IDENTITY or let the harness generate one`,
      );
    }
    const r = Bun.spawnSync(["age-keygen", "-y", id], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`age-keygen -y failed: ${r.stderr.toString().trim()}`);
    }
    return r.stdout.toString().trim();
  }

  /** Encrypt and persist a secret value (armored age ciphertext). */
  async set(name: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dest = this.path(name);
    const proc = Bun.spawn(["age", "-a", "-r", this.recipient(), "-o", dest], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.stdin.write(value);
    await proc.stdin.end();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`age encrypt failed for ${name}: ${await readStderr(proc)}`);
    }
    await chmod(dest, 0o600);
  }

  /** Decrypt a secret value. Callers must never print the result. */
  async get(name: string): Promise<string> {
    const src = this.path(name);
    if (!existsSync(src)) throw new Error(`no such secret: ${name}`);
    const id = resolve(this.cfg.ageIdentityFile);
    if (!existsSync(id)) throw new Error(`age identity not found at ${id}; cannot decrypt ${name}`);
    const proc = Bun.spawn(["age", "-d", "-i", id, src], { stdout: "pipe", stderr: "pipe" });
    const value = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`age decrypt failed for ${name}: ${await readStderr(proc)}`);
    return value;
  }
}

async function readStderr(proc: { stderr: ReadableStream<Uint8Array> | number }): Promise<string> {
  if (typeof proc.stderr === "number") return "";
  return (await new Response(proc.stderr).text()).trim();
}

/** `foreman secret set NAME` — read the value from stdin (pipe), store it, print only a confirmation. */
export async function secretSetFromStdin(cfg: Config, name: string): Promise<void> {
  const value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!value) throw new Error("no secret value on stdin");
  await new SecretsStore(cfg).set(name, value);
  console.log(`stored secret ${name}`);
}

/** `foreman run --secret NAME[,NAME] -- cmd args…` — inject into child env only, exec, forward stdio. */
export async function runWithSecrets(cfg: Config, names: string[], cmd: string[]): Promise<number> {
  const store = new SecretsStore(cfg);
  const injected: Record<string, string> = {};
  for (const name of names) injected[name] = await store.get(name);

  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...injected },
  });
  return await proc.exited;
}
