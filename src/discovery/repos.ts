import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Folders where people usually keep code. IBO_SCAN_ROOTS (colon separated) replaces the list. */
export function defaultScanRoots(home = homedir()): string[] {
  const env = process.env.IBO_SCAN_ROOTS;
  if (env) return env.split(":").filter(Boolean);
  return ["projects", "apps", "code", "dev", "src", "repos", "workspace", "Developer", "git", "Sites"].map((d) => join(home, d));
}

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "vendor", "Library", ".cache"]);

/** Files that mark a folder as a project even without git. */
const MARKERS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "composer.json", "CLAUDE.md", "AGENTS.md", "base44.config.json", ".base44"];

/**
 * Finds projects (git repos, or folders with a project file such as package.json) under the roots, up to `depth` levels down. Does not descend into a repo,
 * so a monorepo counts once. This catches projects that never ran in Claude Code locally.
 */
export function findRepos(roots = defaultScanRoots(), depth = 3, limit = 200): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    if (found.length >= limit) return;
    if (existsSync(join(dir, ".git")) || (level > 0 && MARKERS.some((m) => existsSync(join(dir, m))))) {
      found.push(dir);
      return;
    }
    if (level >= depth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, level + 1);
      } catch {
        /* unreadable */
      }
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root, 0);
  return found;
}
