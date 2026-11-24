import { describe, expect, it } from "vitest";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjects, loadSettings, loadTools, saveProjects, saveSettings, saveTools } from "../../src/config/load.js";
import { ensureHome, iboHome, paths } from "../../src/config/paths.js";
import { Project, Settings } from "../../src/config/schema.js";

describe("paths", () => {
  it("follow IBO_HOME", () => {
    expect(iboHome()).toBe(process.env.IBO_HOME);
    expect(paths.projects).toBe(join(process.env.IBO_HOME!, "projects.yaml"));
  });
  it("ensureHome creates the folders with private permissions", () => {
    ensureHome();
    for (const d of [paths.home, paths.summaries, paths.worktrees, paths.logs]) expect(existsSync(d)).toBe(true);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
  });
});

describe("config files", () => {
  it("return defaults when files are missing", () => {
    const s = loadSettings();
    expect(s.mode).toBe("suggest");
    expect(s.killSwitch).toBe(false);
    expect(s.models.plan.provider).toBe("anthropic");
    expect(loadProjects().projects).toEqual([]);
    expect(loadTools().tools).toEqual({});
  });

  it("round-trip settings, projects and tools", () => {
    const s = Settings.parse({ mode: "auto", killSwitch: true });
    saveSettings(s);
    expect(loadSettings()).toEqual(s);

    const p = Project.parse({ id: "acme", playbook: { prepare_fix: { kind: "claude-code", repo: "/r" } } });
    saveProjects({ projects: [p] });
    expect(loadProjects().projects[0].playbook.prepare_fix).toEqual({ kind: "claude-code", repo: "/r", baseBranch: "main" });

    saveTools({ tools: { "jira/create_issue": 2 } });
    expect(loadTools().tools["jira/create_issue"]).toBe(2);
    expect(statSync(paths.tools).mode & 0o777).toBe(0o600);
  });

  it("explain invalid files with the field path", () => {
    ensureHome();
    writeFileSync(paths.settings, "mode: sometimes\n");
    expect(() => loadSettings()).toThrow(/mode/);
  });

  it("reject bad project ids and unknown risk levels", () => {
    expect(() => Project.parse({ id: "has spaces" })).toThrow();
    ensureHome();
    writeFileSync(paths.tools, "tools:\n  a/b: 7\n");
    expect(() => loadTools()).toThrow(/Invalid config/);
  });

  it("treat an empty file as defaults", () => {
    ensureHome();
    writeFileSync(paths.projects, "");
    expect(loadProjects().projects).toEqual([]);
  });
});
