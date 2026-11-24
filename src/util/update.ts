import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The installed checkout (~/.inbox-orchestrator-app): two levels above dist/util/update.js. */
export const appDir = () => process.env.IBO_APP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Only installs made by scripts/install.sh update themselves, never a development checkout. */
export function canSelfUpdate(dir = appDir()): boolean {
  return existsSync(join(dir, ".git")) && existsSync(join(dir, ".ibo-installed")) && process.env.IBO_NO_AUTO_UPDATE !== "1";
}

export interface UpdateResult {
  updated: boolean;
  from?: string;
  to?: string;
  error?: string;
}

const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args], { timeout: 120_000 }).then((r) => r.stdout.trim());

async function build(dir: string): Promise<void> {
  const opts = { cwd: dir, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 };
  await run("npm", ["ci", "--ignore-scripts", "--no-fund", "--no-audit", "--loglevel=error"], opts);
  await run(process.execPath, [join(dir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], opts);
  await run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit", "--loglevel=error"], opts);
  await run(process.execPath, [join(dir, "dist", "cli.js"), "--version"], { cwd: dir, timeout: 30_000 });
}

/**
 * Fast-forwards the checkout to origin's default branch and rebuilds. If the new version
 * does not build or start, it goes back to the previous commit, so an update never leaves
 * the agent broken.
 */
export async function selfUpdate(dir = appDir()): Promise<UpdateResult> {
  if (!existsSync(join(dir, ".git"))) return { updated: false, error: "not a git install" };
  const from = await git(dir, "rev-parse", "HEAD");
  await git(dir, "fetch", "--quiet", "origin");
  const to = await git(dir, "rev-parse", "@{u}").catch(() => git(dir, "rev-parse", "origin/HEAD"));
  if (from === to) return { updated: false, from, to };
  try {
    await git(dir, "merge", "--ff-only", "--quiet", to);
    await build(dir);
    return { updated: true, from, to };
  } catch (err) {
    await git(dir, "reset", "--hard", "--quiet", from).catch(() => undefined);
    await build(dir).catch(() => undefined);
    return { updated: false, from, to, error: err instanceof Error ? err.message.slice(0, 500) : String(err) };
  }
}
