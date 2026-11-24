import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/gmail/auth.js", async (orig) => {
  const real = await orig<typeof import("../../src/gmail/auth.js")>();
  const { setSecret } = await import("../../src/util/secrets.js");
  return {
    ...real,
    authorizeInteractive: vi.fn(async (opts: { onUrl?: (u: string) => void } = {}) => {
      opts.onUrl?.("https://accounts.google.com/o/oauth2/v2/auth?x=1");
      await new Promise((r) => setTimeout(r, 50));
      if (process.env.FAKE_GOOGLE_FAIL) throw new Error("access_denied");
      await setSecret("google-refresh-token", "rt");
    }),
  };
});

const { saveProjects, saveSettings, loadProjects, loadSettings, loadTools } = await import("../../src/config/load.js");
const { Settings } = await import("../../src/config/schema.js");
const { buildRuntime } = await import("../../src/runtime.js");
const { apiToken, buildApi } = await import("../../src/server/api.js");

let rt: ReturnType<typeof buildRuntime>;
let app: ReturnType<typeof buildApi>;
let auth: Record<string, string>;
const realHome = process.env.HOME;
let ollama: Server | null = null;

const call = async (url: string, payload?: unknown) => {
  const res = await app.inject({ method: payload === undefined ? "GET" : "POST", url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
  return res.json();
};
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
};

beforeEach(() => {
  // A Mac with one project: a git repo that Claude Code worked in, using a local MCP server.
  const home = mkdtempSync(join(tmpdir(), "ibo-setup-home-"));
  process.env.HOME = home;
  process.env.IBO_TEST_INBOX = join(home, "inbox.json");
  const folder = join(home, "code", "hawk");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["-C", folder, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", folder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const sessions = join(home, ".claude", "projects", "-code-hawk");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s.jsonl"), JSON.stringify({ cwd: folder, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", name: "mcp__apps__create_ticket" }] } }));
  saveSettings(Settings.parse({}));
  saveProjects({ projects: [] });
  rt = buildRuntime(() => {});
  app = buildApi(rt);
  auth = { authorization: `Bearer ${apiToken()}` };
});

afterEach(async () => {
  await app.close();
  await rt.close();
  ollama?.close();
  ollama = null;
  process.env.HOME = realHome;
  delete process.env.IBO_TEST_INBOX;
  delete process.env.FAKE_GOOGLE_FAIL;
  delete process.env.IBO_BLOCK_LOCAL_MODELS;
});

describe("setup API for the app's first-run window", () => {
  it("reports what is missing on a fresh Mac", async () => {
    const s = await call("/setup/status");
    expect(s).toMatchObject({ done: false, projects: 0, google: { connected: false, state: "idle" }, claude: { route: null, installed: false } });
    expect(s.model).toMatchObject({ allowed: true, running: false, ready: false });
    expect(typeof s.model.name).toBe("string");
  });

  it("runs the Google sign-in in the background and reports when it is done or failed", async () => {
    const start = await call("/setup/google", {});
    expect(start.url).toMatch(/^https:\/\/accounts.google.com/);
    await until(async () => (await call("/setup/status")).google.connected);
    expect((await call("/setup/status")).google.state).toBe("done");
  });

  it("shows a failed sign-in", async () => {
    process.env.FAKE_GOOGLE_FAIL = "1";
    await call("/setup/google", {});
    await until(async () => (await call("/setup/status")).google.state === "error");
    expect((await call("/setup/status")).google.error).toBe("access_denied");
  });

  it("saves an API key", async () => {
    expect((await call("/setup/claude-key", { key: " " })).error).toBeTruthy();
    expect(await call("/setup/claude-key", { key: "sk-ant-1" })).toEqual({ ok: true });
    expect((await call("/setup/status")).claude.route).toBe("api");
  });

  it("downloads the local model with progress and switches triage to it", async () => {
    const pulled: string[] = [];
    ollama = createServer((req, res) => {
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: pulled.map((name) => ({ name })) }));
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { model } = JSON.parse(body);
        res.write(JSON.stringify({ status: "pulling", total: 100, completed: 40 }) + "\n");
        setTimeout(() => {
          res.write(JSON.stringify({ status: "pulling", total: 100, completed: 100 }) + "\n");
          pulled.push(model);
          res.end(JSON.stringify({ status: "success" }) + "\n");
        }, 30);
      });
    });
    await new Promise<void>((r) => ollama!.listen(0, "127.0.0.1", r));
    const s = loadSettings();
    s.models.ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    saveSettings(s);
    rt.reload();

    expect((await call("/setup/model", {})).state).toBe("running");
    await until(async () => (await call("/setup/status")).model.state === "done");
    const m = (await call("/setup/status")).model;
    expect(m).toMatchObject({ ready: true, progress: 1 });
    expect(loadSettings().models.filter.provider).toBe("ollama");
    expect(pulled).toHaveLength(1);
  });

  it("refuses the local model when the organization blocks it", async () => {
    process.env.IBO_BLOCK_LOCAL_MODELS = "1";
    expect((await call("/setup/model", {})).error).toMatch(/organization/);
    expect((await call("/setup/status")).model.allowed).toBe(false);
  });

  it("discovers projects, saves the picks with edited domains plus a project added by hand, and finishes", async () => {
    expect(await call("/setup/exports")).toEqual([]);
    await call("/setup/discover", { imports: [] });
    await until(async () => (await call("/setup/status")).discover.state === "done");
    const { active } = await call("/setup/candidates");
    const hawk = active.find((c: { id: string }) => c.id === "hawk");
    expect(hawk).toMatchObject({ status: "live", recommended: "add" });
    expect(hawk.actions.join()).toMatch(/Claude Code/);

    expect((await call("/setup/projects", { picks: [{ id: "ghost" }] })).error).toMatch(/Unknown project/);
    const saved = await call("/setup/projects", {
      picks: [{ id: "hawk", domains: ["@Coleven.com "] }],
      manual: [{ name: "Shamir decisions", domains: ["shamir.org.il"] }, { name: " " }],
    });
    expect(saved).toEqual({ saved: 2, projects: 2 });
    const byId = Object.fromEntries(loadProjects().projects.map((p) => [p.id, p]));
    expect(byId.hawk.match.domains).toEqual(["coleven.com"]);
    expect(byId["shamir-decisions"].playbook.create_reminder).toEqual({ kind: "reminder" });
    expect(rt.projects()).toHaveLength(2);
    expect(loadTools()).toBeDefined();

    expect(await call("/setup/finish", {})).toEqual({ ok: true });
    expect((await call("/setup/status")).done).toBe(true);
    expect(readFileSync(join(process.env.IBO_HOME!, "projects.yaml"), "utf8")).toContain("coleven.com");
  });
});
