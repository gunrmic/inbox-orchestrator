import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { iboHome } from "../config/paths.js";

const run = promisify(execFile);
const SERVICE = "inbox-orchestrator";

/** Keychain on macOS. IBO_SECRETS_BACKEND=file forces the file backend (used by tests and CI). */
const useKeychain = () => platform() === "darwin" && process.env.IBO_SECRETS_BACKEND !== "file";

/**
 * Secrets live in the macOS Keychain. On other platforms (CI, Linux dev boxes) they fall
 * back to a 0600 file in the state folder. Secrets never go into the YAML config files.
 */
export async function getSecret(name: string): Promise<string | null> {
  if (useKeychain()) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  const file = fallbackFile(name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (useKeychain()) {
    await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value]);
    return;
  }
  const dir = join(iboHome(), "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(fallbackFile(name), value, { mode: 0o600 });
}

function fallbackFile(name: string): string {
  return join(iboHome(), "secrets", name.replace(/[^a-z0-9_-]/gi, "_"));
}

export async function anthropicKey(): Promise<string | null> {
  return process.env.ANTHROPIC_API_KEY ?? (await getSecret("anthropic-api-key"));
}
