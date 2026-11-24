import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Answer every interactive prompt like a user who takes the recommended option.
const answers = { select: [] as unknown[], input: [] as string[], checkbox: [] as unknown[][] };
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async ({ choices }: { choices: { value: unknown }[] }) => (answers.select.length ? answers.select.shift() : choices[0].value)),
  input: vi.fn(async ({ default: d }: { default?: string }) => answers.input.shift() ?? d ?? ""),
  checkbox: vi.fn(async () => answers.checkbox.shift() ?? []),
  confirm: vi.fn(async () => false),
  password: vi.fn(async () => ""),
}));

const { onboard } = await import("../../src/discovery/onboard.js");
const { loadProjects, loadTools } = await import("../../src/config/load.js");
const { ModelRouter } = await import("../../src/models/router.js");
const { Settings } = await import("../../src/config/schema.js");
import type { Provider } from "../../src/models/providers.js";

const SERVER = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const realHome = process.env.HOME;
let home: string;
let folder: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ibo-home-"));
  process.env.HOME = home;
  folder = join(home, "code", "hawk");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["-C", folder, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  writeFileSync(join(folder, "CLAUDE.md"), "Hawk Graph: investigation app on Base44");

  // Claude Code config with one MCP server and session history that uses it in this folder.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { apps: { command: process.execPath, args: [SERVER] } } }));
  const sessions = join(home, ".claude", "projects", "-code-hawk");
  mkdirSync(sessions, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(sessions, "s.jsonl"),
    [
      { cwd: folder, timestamp: now, message: { content: [{ type: "tool_use", name: "mcp__apps__list_apps" }] } },
      { cwd: folder, timestamp: now, message: { content: [{ type: "tool_use", name: "mcp__apps__create_checkpoint" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  answers.select = [];
  answers.input = [];
  answers.checkbox = [];
});

afterEach(() => {
  process.env.HOME = realHome;
});

describe("onboarding end to end (real files, real MCP server, scripted answers)", () => {
  it("without a model: proposes the folder, asks for email matching, writes config", async () => {
    // Recommended choice for a project with no email link is "edit"; then type the domain.
    answers.input = ["coleven.com", "jack@coleven.com"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    await onboard(null);

    const [p] = loadProjects().projects;
    expect(p.id).toBe("hawk");
    expect(p.status).toBe("live");
    expect(p.match.domains).toEqual(["coleven.com"]);
    expect(p.match.senders).toEqual(["jack@coleven.com"]);
    expect(p.playbook.prepare_fix).toMatchObject({ kind: "claude-code", repo: folder });
    expect(readFileSync(join(process.env.IBO_HOME!, "projects", "hawk.md"), "utf8")).toContain("Base44");
  });

  it("with a model: uses the user's MCP tools and asks to confirm their risk", async () => {
    const provider: Provider = {
      id: "anthropic",
      available: async () => true,
      structured: async (_m, req) => {
        // The probe's read-only listing reached the model as evidence.
        expect(req.user).toContain("Hawk Graph");
        return {
          projects: [
            {
              id: "hawk",
              name: "Hawk Graph",
              folder,
              domains: ["coleven.com"],
              summary: "Base44 app",
              confidence: 0.9,
              playbook: { prepare_fix: { kind: "mcp", server: "apps", tool: "create_checkpoint" } },
              question: { text: "Is Hawk the ColEven app?", options: [{ label: "Yes", reason: "matching names" }, { label: "No", reason: "" }] },
            },
          ],
        };
      },
    };
    const models = new ModelRouter({ settings: Settings.parse({}).models, allowLocalModels: false, providers: { anthropic: provider, ollama: provider } });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await onboard(models);

    const [p] = loadProjects().projects;
    expect(p.playbook.prepare_fix).toEqual({ kind: "mcp", server: "apps", tool: "create_checkpoint" });
    expect(p.match.domains).toEqual(["coleven.com"]);
    // create_checkpoint is suggested as level 1 and the recommended answer was taken
    expect(loadTools().tools["apps/create_checkpoint"]).toBe(1);
    expect(existsSync(join(process.env.IBO_HOME!, "projects", "hawk.md"))).toBe(true);
  });

  it("merges with existing projects instead of overwriting them", async () => {
    const { saveProjects } = await import("../../src/config/load.js");
    const { Project } = await import("../../src/config/schema.js");
    saveProjects({ projects: [Project.parse({ id: "existing" })] });
    answers.select = ["skip"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    await onboard(null);
    expect(loadProjects().projects.map((p) => p.id)).toEqual(["existing"]);
  });
});
