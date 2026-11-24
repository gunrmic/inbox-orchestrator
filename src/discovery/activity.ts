import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectStatus } from "../config/schema.js";

const run = promisify(execFile);

export const DEFAULT_THRESHOLDS = { liveDays: 30, deadDays: 180 };

/** The newest of several activity signals decides the status. */
export function newest(...dates: (string | null | undefined)[]): string | null {
  const valid = dates.filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
}

export function statusFrom(
  lastActivity: string | null,
  now = Date.now(),
  t = DEFAULT_THRESHOLDS,
): ProjectStatus {
  if (!lastActivity) return "dead";
  const days = (now - Date.parse(lastActivity)) / 86_400_000;
  if (days <= t.liveDays) return "live";
  if (days <= t.deadDays) return "dormant";
  return "dead";
}

export interface RepoInfo {
  folder: string;
  isGit: boolean;
  lastCommit: string | null;
  defaultBranch: string | null;
  remote: string | null;
}

export async function repoInfo(folder: string): Promise<RepoInfo> {
  const info: RepoInfo = { folder, isGit: false, lastCommit: null, defaultBranch: null, remote: null };
  if (!existsSync(join(folder, ".git"))) return info;
  info.isGit = true;
  try {
    info.lastCommit = (await run("git", ["-C", folder, "log", "-1", "--format=%cI"])).stdout.trim() || null;
  } catch {
    /* empty repo */
  }
  try {
    const head = (await run("git", ["-C", folder, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
    info.defaultBranch = head.replace(/^origin\//, "");
  } catch {
    try {
      info.defaultBranch = (await run("git", ["-C", folder, "branch", "--show-current"])).stdout.trim() || null;
    } catch {
      /* ignore */
    }
  }
  try {
    info.remote = (await run("git", ["-C", folder, "remote", "get-url", "origin"])).stdout.trim() || null;
  } catch {
    /* no remote */
  }
  return info;
}

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".cache", "vendor", "target", ".venv", "__pycache__"]);

/**
 * Newest modification time of a file in the folder, ignoring build output and dependencies.
 * Catches work that was never committed. Stops after `budget` entries to stay fast on big trees.
 */
export function lastFileChange(folder: string, budget = 4000): string | null {
  let newestMs = 0;
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > budget) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen++ > budget) return;
      if (IGNORE.has(name) || name === ".DS_Store") continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
    }
  };
  if (!existsSync(folder)) return null;
  walk(folder, 0);
  return newestMs ? new Date(newestMs).toISOString() : null;
}
