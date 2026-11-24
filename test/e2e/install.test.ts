import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./harness.js";

/**
 * Runs scripts/install.sh for real: clone, npm ci, build, npm link, then uses the
 * installed `ibo`. It installs from a snapshot of the current working tree, so it
 * tests the code being committed, and links into a temporary npm prefix.
 */
function snapshotRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ibo-src-"));
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "snapshot"]);
  return dir;
}

function runInstaller(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [join(ROOT, "scripts", "install.sh")], { env, encoding: "utf8", input: "" });
}

describe("install.sh", () => {
  it("installs, links `ibo`, and updates on a second run", () => {
    const repo = snapshotRepo();
    const work = mkdtempSync(join(tmpdir(), "ibo-install-"));
    const prefix = join(work, "npm-prefix");
    const env = {
      ...process.env,
      HOME: work,
      IBO_HOME: join(work, ".inbox-orchestrator"),
      IBO_REPO: repo,
      IBO_APP_DIR: join(work, "app"),
      IBO_SKIP_OPTIONAL: "1",
      IBO_SECRETS_BACKEND: "file",
      npm_config_prefix: prefix,
      npm_config_cache: join(process.env.HOME ?? work, ".npm"),
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    };

    const first = runInstaller(env);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("Downloading to");
    expect(first.stdout).toMatch(/Installed \d+\.\d+\.\d+/);

    // No install scripts ran and no dev tooling stays behind (esbuild broke installs on macOS).
    expect(existsSync(join(work, "app", "node_modules", "esbuild"))).toBe(false);
    expect(existsSync(join(work, "app", "node_modules", "vitest"))).toBe(false);
    expect(existsSync(join(work, "app", "node_modules", "fastify"))).toBe(true);

    const ibo = join(prefix, "bin", "ibo");
    expect(existsSync(ibo)).toBe(true);
    const version = spawnSync(ibo, ["--version"], { env, encoding: "utf8" });
    expect(version.status).toBe(0);
    const doctor = spawnSync(ibo, ["doctor"], { env, encoding: "utf8" });
    expect(doctor.stdout).toContain("Projects mapped");

    const second = runInstaller(env);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("Updating");
  });

  it("fails early with a clear message when Node is too old", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "ibo-oldnode-"));
    writeFileSync(join(fakeBin, "node"), "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then echo v18.0.0; else exit 1; fi\n");
    chmodSync(join(fakeBin, "node"), 0o755);
    const r = runInstaller({ ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, IBO_SKIP_OPTIONAL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("22.13+");
  });
});
