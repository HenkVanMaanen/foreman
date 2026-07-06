// Encrypted secret store + the two primitives that keep secret *values* out of the
// agent's context:
//   - `foreman secret set NAME`   : reads the value from STDIN, encrypts, stores.
//   - `foreman run --secret NAME -- cmd` : decrypts, injects into the child env only, execs.
//
// The agent references secrets by NAME. A value only ever lives in: this store (encrypted
// at rest), a pipe during capture, and a child process's env during use — never in the
// model's transcript, notes, or logs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";

interface SealedSecret {
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// Coerce any Uint8Array into a plain ArrayBuffer-backed view so Web Crypto's
// BufferSource typing (which excludes SharedArrayBuffer) is satisfied.
const ab = (u: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
};

export class SecretsStore {
  private dir: string;

  constructor(private cfg: Config) {
    this.dir = join(cfg.stateDir, "secrets");
  }

  private path(name: string): string {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`invalid secret name: ${name} (use UPPER_SNAKE_CASE)`);
    }
    return join(this.dir, `${name}.json`);
  }

  private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    if (!this.cfg.secretsPassphrase) {
      throw new Error("FOREMAN_SECRETS_PASSPHRASE is not set; cannot use the secret store");
    }
    const base = await crypto.subtle.importKey(
      "raw",
      ab(enc.encode(this.cfg.secretsPassphrase)),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: ab(salt), iterations: 200_000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /** Encrypt and persist a secret value. */
  async set(name: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(enc.encode(value)));
    const sealed: SealedSecret = { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
    await writeFile(this.path(name), JSON.stringify(sealed), { mode: 0o600 });
  }

  /** Decrypt a secret value. Callers must never print the result. */
  async get(name: string): Promise<string> {
    const sealed = JSON.parse(await readFile(this.path(name), "utf8")) as SealedSecret;
    const key = await this.deriveKey(unb64(sealed.salt));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ab(unb64(sealed.iv)) },
      key,
      ab(unb64(sealed.ct)),
    );
    return dec.decode(pt);
  }
}

/** `foreman secret set NAME` — read the value from stdin (pipe), store it, print only a confirmation. */
export async function secretSetFromStdin(cfg: Config, name: string): Promise<void> {
  const value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!value) throw new Error("no secret value on stdin");
  await new SecretsStore(cfg).set(name, value);
  console.log(`stored secret ${name}`);
}

/** `foreman run --secret NAME[,NAME] -- cmd args…` — inject into child env only, exec, forward stdio. */
export async function runWithSecrets(
  cfg: Config,
  names: string[],
  cmd: string[],
): Promise<number> {
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
