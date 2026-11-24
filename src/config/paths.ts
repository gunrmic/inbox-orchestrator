import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** All state lives in one folder. Override with IBO_HOME (used by tests). */
export function iboHome(): string {
  return process.env.IBO_HOME ?? join(homedir(), ".inbox-orchestrator");
}

export const paths = {
  get home() {
    return iboHome();
  },
  get settings() {
    return join(iboHome(), "settings.yaml");
  },
  get projects() {
    return join(iboHome(), "projects.yaml");
  },
  get tools() {
    return join(iboHome(), "tools.yaml");
  },
  get summaries() {
    return join(iboHome(), "projects");
  },
  get db() {
    return join(iboHome(), "state.db");
  },
  get token() {
    return join(iboHome(), "api-token");
  },
  get worktrees() {
    return join(iboHome(), "worktrees");
  },
  get logs() {
    return join(iboHome(), "logs");
  },
};

export function ensureHome(): void {
  for (const dir of [paths.home, paths.summaries, paths.worktrees, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
