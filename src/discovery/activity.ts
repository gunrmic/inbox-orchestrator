import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
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
