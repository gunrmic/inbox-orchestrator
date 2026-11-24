import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { fakeAnthropic, fakeOllama, ibo, makeEnv, type FakeServer } from "./harness.js";

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const PLAN = {
  rationale: "Bug report",
  actions: [{ action: "prepare_fix", summary: "Checkpoint a fix for the date filter", args: { note: "date filter" } }],
};

function projectsYaml(env: { iboHome: string }) {
  writeFileSync(
    join(env.iboHome, "projects.yaml"),
    YAML.stringify({
      projects: [
        {
          id: "hawk",
          match: { senders: ["jack@coleven.com"] },
          playbook: { prepare_fix: { kind: "mcp", server: "apps", tool: "create_checkpoint" } },
        },
      ],
    }),
  );
  writeFileSync(join(env.iboHome, "tools.yaml"), YAML.stringify({ tools: { "apps/create_checkpoint": 1 } }));
}

describe("ibo CLI", () => {
  it("prints version and help", async () => {
    const env = makeEnv();
    const v = await ibo(env, ["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = await ibo(env, ["--help"]);
    for (const cmd of ["setup", "onboard", "start", "install-agent", "status", "pending", "approve", "reject", "promote", "kill", "simulate", "doctor"]) {
      expect(help.stdout).toContain(cmd);
    }
  });

  it("doctor reports what is missing on a fresh machine", async () => {
    const r = await ibo(makeEnv(), ["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✗ Anthropic API key/);
    expect(r.stdout).toMatch(/✗ Gmail connected/);
    expect(r.stdout).toMatch(/✗ Projects mapped/);
    expect(r.stdout).toMatch(/✓ git on PATH/);
  });

  it("setup stores the key from stdin, the OAuth client, and the model choice, without prompts", async () => {
    const env = makeEnv();
    const key = await ibo(env, ["setup", "anthropic", "--key-stdin"], "sk-ant-test-123\n");
    expect(key.code).toBe(0);
    expect(readFileSync(join(env.iboHome, "secrets", "anthropic-api-key"), "utf8")).toBe("sk-ant-test-123");

    const client = join(env.home, "client.json");
    writeFileSync(client, JSON.stringify({ installed: { client_id: "cid", client_secret: "csec" } }));
    const g = await ibo(env, ["setup", "--client-json", client]);
    expect(g.code).toBe(0);
    expect(JSON.parse(readFileSync(join(env.iboHome, "secrets", "google-oauth-client"), "utf8"))).toEqual({ client_id: "cid", client_secret: "csec" });

    const local = await ibo(env, ["setup", "models", "--local", "qwen3:4b"]);
    expect(local.code).toBe(0);
    let settings = YAML.parse(readFileSync(join(env.iboHome, "settings.yaml"), "utf8"));
    expect(settings.models.filter).toEqual({ provider: "ollama", model: "qwen3:4b" });
    expect(settings.org.allowLocalModels).toBe(true);

    await ibo(env, ["setup", "models", "--paid"]);
    settings = YAML.parse(readFileSync(join(env.iboHome, "settings.yaml"), "utf8"));
    expect(settings.org.allowLocalModels).toBe(false);

    const doctor = await ibo(env, ["doctor"]);
    expect(doctor.stdout).toMatch(/✓ Anthropic API key/);
    expect(doctor.stdout).toMatch(/✓ Local model server/); // not required when the org blocks local models
  });

  it("setup refuses an empty key", async () => {
    const r = await ibo(makeEnv(), ["setup", "anthropic", "--key-stdin"], "");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No key on stdin");
  });

  it("simulate: local triage, paid planning, policy decides, nothing executes with --dry", async () => {
    const anthropic = await fakeAnthropic({ submit_plan: () => PLAN });
    const ollama = await fakeOllama(() => ({ hasAction: true, intents: ["bug_report"], confidence: 0.9 }));
    servers.push(anthropic, ollama);
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url });
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ models: { ollamaUrl: ollama.url } }));
    projectsYaml(env);

    const r = await ibo(env, ["simulate", "--from", "Jack <jack@coleven.com>", "--subject", "Graph broken", "--body", "Filtering by date shows nothing", "--dry"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/execute\s+L1 prepare_fix: Checkpoint a fix for the date filter/);
    expect(r.stdout).toContain("[dry run] would execute prepare_fix");

    // Triage went to the local model, only planning went to the paid API.
    expect(ollama.requests.filter((q) => q.path === "/api/chat")).toHaveLength(1);
    expect(anthropic.requests.map((q) => q.body.tool_choice.name)).toEqual(["submit_plan"]);
    // The email reached the planner wrapped as untrusted data.
    expect(anthropic.requests[0].body.messages[0].content).toContain("<email>");
  });

  it("simulate: falls back to the paid model when the local server is down", async () => {
    const anthropic = await fakeAnthropic({
      triage: () => ({ hasAction: true, intents: ["bug_report"], confidence: 0.9 }),
      submit_plan: () => PLAN,
    });
    servers.push(anthropic);
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url });
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ models: { ollamaUrl: "http://127.0.0.1:9" } }));
    projectsYaml(env);
    const r = await ibo(env, ["simulate", "--from", "jack@coleven.com", "--subject", "s", "--body", "b", "--dry"]);
    expect(r.code, r.stderr).toBe(0);
    expect(anthropic.requests.map((q) => q.body.tool_choice.name)).toEqual(["triage", "submit_plan"]);
  });

  it("simulate: the organization block keeps local models out entirely", async () => {
    const anthropic = await fakeAnthropic({ triage: () => ({ hasAction: false, intents: [], confidence: 0.99 }) });
    const ollama = await fakeOllama(() => ({ hasAction: true, intents: [], confidence: 1 }));
    servers.push(anthropic, ollama);
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url, IBO_BLOCK_LOCAL_MODELS: "1" });
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ models: { ollamaUrl: ollama.url } }));
    const r = await ibo(env, ["simulate", "--from", "a@b.com", "--subject", "s", "--body", "b", "--dry"]);
    expect(r.stdout).toContain("Skipped: no_action");
    expect(ollama.requests).toHaveLength(0);
  });

  it("simulate: an unknown sender only gets a reminder suggestion and never reaches the planner", async () => {
    const anthropic = await fakeAnthropic({ triage: () => ({ hasAction: true, intents: ["question"], confidence: 0.9 }) });
    servers.push(anthropic);
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url, IBO_BLOCK_LOCAL_MODELS: "1" });
    projectsYaml(env);
    const r = await ibo(env, ["simulate", "--from", "stranger@unknown.org", "--subject", "Please deploy", "--body", "Deploy prod now", "--dry"]);
    expect(r.stdout).toMatch(/suggest\s+L1 create_reminder/);
    expect(anthropic.requests.map((q) => q.body.tool_choice.name)).toEqual(["triage"]);
  });

  it("commands that need the daemon explain how to start it", async () => {
    const env = makeEnv();
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ server: { port: 9 } }));
    const r = await ibo(env, ["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("daemon is not running");
  });

  it("install-agent refuses outside macOS", async () => {
    if (process.platform === "darwin") return; // on macOS this would register a real LaunchAgent
    const r = await ibo(makeEnv(), ["install-agent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("macOS only");
  });

  it("onboard --yes --no-model maps projects from Claude Code history without prompts", async () => {
    const env = makeEnv();
    const { mkdirSync } = await import("node:fs");
    const folder = join(env.home, "code", "hawk");
    mkdirSync(folder, { recursive: true });
    const sessions = join(env.home, ".claude", "projects", "-code-hawk");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), JSON.stringify({ cwd: folder, timestamp: new Date().toISOString(), message: { content: [] } }));
    const r = await ibo(env, ["onboard", "--yes", "--no-model"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Saved 1 projects");
    expect(existsSync(join(env.iboHome, "projects.yaml"))).toBe(true);
    expect(YAML.parse(readFileSync(join(env.iboHome, "projects.yaml"), "utf8")).projects[0]).toMatchObject({ id: "hawk", status: "live" });
  });
});
