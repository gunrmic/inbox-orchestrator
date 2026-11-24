import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * End to end through the menu bar app: a real daemon (built CLI) with a fixture inbox,
 * a fake Anthropic API, and the fixture MCP server. The test clicks the real UI and
 * checks the effect in the MCP server's call log.
 */
const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const MCP_SERVER = join(ROOT, "test", "fixtures", "mcp-server.mjs");
const MAIN = join(__dirname, "..", "main.js");

const readLines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

async function fakeAnthropic(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const name = body.tool_choice.name;
      const input =
        name === "triage"
          ? { hasAction: true, intents: ["bug_report"], confidence: 0.95 }
          : { rationale: "r", actions: [{ action: "create_task", summary: "Open a ticket for the date filter bug", args: { title: "Date filter bug" } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "tool_use", id: "t", name, input }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

let daemon: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let closeApi: (() => void) | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => {});
  daemon?.kill("SIGTERM");
  closeApi?.();
  app = null;
  daemon = null;
});

function workspace(port: number) {
  const home = mkdtempSync(join(tmpdir(), "ibo-mb-"));
  const iboHome = join(home, ".inbox-orchestrator");
  mkdirSync(iboHome, { recursive: true });
  const mcpLog = join(home, "mcp.jsonl");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { apps: { command: process.execPath, args: [MCP_SERVER], env: { FIXTURE_LOG: mcpLog } } } }));
  writeFileSync(join(iboHome, "settings.yaml"), `server:\n  port: ${port}\n`);
  writeFileSync(
    join(iboHome, "projects.yaml"),
    "projects:\n  - id: hawk\n    match:\n      senders: [jack@coleven.com]\n    playbook:\n      create_task: { kind: mcp, server: apps, tool: create_ticket }\n",
  );
  writeFileSync(join(iboHome, "tools.yaml"), "tools:\n  apps/create_ticket: 2\n");
  const inbox = join(home, "inbox.json");
  writeFileSync(
    inbox,
    JSON.stringify([
      {
        id: "jack-1",
        threadId: "t1",
        from: "Jack <jack@coleven.com>",
        fromAddress: "jack@coleven.com",
        to: [],
        cc: [],
        subject: "Graph does not load",
        date: new Date().toISOString(),
        snippet: "",
        body: "Filtering by date shows nothing",
        attachments: [],
        auth: { spf: "pass", dkim: "pass" },
      },
    ]),
  );
  return { home, iboHome, mcpLog, inbox };
}

async function launchMenubar(env: Record<string, string>): Promise<Page> {
  app = await electron.launch({ args: [MAIN, "--no-sandbox"], env: { ...process.env, ...env } as Record<string, string> });
  return app.firstWindow();
}

test("shows the daemon is not running", async () => {
  const port = await freePort();
  const ws = workspace(port);
  const page = await launchMenubar({ HOME: ws.home, IBO_HOME: ws.iboHome });
  await expect(page.locator("#stopped")).toContainText("The agent is not running");
  await expect(page.locator("#start")).toBeVisible();
});

test("the Start button runs the agent from the app, and its status shows in the window", async () => {
  const port = await freePort();
  const ws = workspace(port);
  const env = { HOME: ws.home, IBO_HOME: ws.iboHome, IBO_SECRETS_BACKEND: "file", IBO_NO_AUTO_UPDATE: "1", IBO_CLAUDE_BIN: join(ws.home, "no-claude"), IBO_SCAN_ROOTS: join(ws.home, "none") };
  const page = await launchMenubar(env);
  await expect(page.locator("#stopped")).toBeVisible();
  await page.locator("#start").click();
  // No Gmail yet: the agent runs and says what it is waiting for.
  await expect(page.locator("#status")).toContainText("Not connected to Gmail yet", { timeout: 20_000 });
  await expect(page.locator("#stop")).toBeVisible();
  await page.locator("#tab-activity").click();
  await expect(page.locator("#activity")).toContainText("No activity yet");
});

test("approve a card from the menu bar and toggle the kill switch", async () => {
  const port = await freePort();
  const ws = workspace(port);
  const api = await fakeAnthropic();
  closeApi = api.close;
  const env = {
    HOME: ws.home,
    IBO_HOME: ws.iboHome,
    IBO_SECRETS_BACKEND: "file",
    IBO_CLAUDE_BIN: join(ws.home, "no-claude"),
    IBO_NO_AUTO_UPDATE: "1",
    IBO_TEST_INBOX: ws.inbox,
    IBO_BLOCK_LOCAL_MODELS: "1",
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_BASE_URL: api.url,
  };

  daemon = spawn(process.execPath, [CLI, "start"], { env: { ...process.env, ...env } });
  let out = "";
  daemon.stdout!.on("data", (d) => (out += d));
  await expect.poll(() => out, { timeout: 20_000 }).toContain("Watching");

  const page = await launchMenubar(env);
  const card = page.locator(".card");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.locator(".summary")).toHaveText("Open a ticket for the date filter bug");
  await expect(card.locator(".risk")).toHaveText("Visible to others");
  await expect(card.locator(".email")).toContainText("Graph does not load");
  expect(readLines(ws.mcpLog).some((c) => c.tool === "create_ticket")).toBe(false);

  // Edit the details, then approve: the edited args reach the user's MCP tool.
  await card.locator("summary").click();
  await card.locator(".args").fill(JSON.stringify({ title: "Edited title" }));
  await card.locator(".edit").click();
  await expect(page.locator("#cards")).toContainText("Nothing waiting for you.");
  await expect.poll(() => readLines(ws.mcpLog).find((c) => c.tool === "create_ticket")?.args).toEqual({ title: "Edited title" });

  // The activity tab tells what happened, in words.
  await page.locator("#tab-activity").click();
  await expect(page.locator("#activity")).toContainText("New email: “Graph does not load”");
  await expect(page.locator("#activity")).toContainText("You approved");

  // Kill switch from the UI is persisted by the daemon.
  await page.locator("label.switch").click();
  await expect(page.locator("#kill")).toBeChecked();
  await expect(page.locator("#status")).toContainText("Paused");
  await expect.poll(() => readFileSync(join(ws.iboHome, "settings.yaml"), "utf8")).toContain("killSwitch: true");
});

test("an unknown sender asks which project it belongs to, then gets that project's actions", async () => {
  const port = await freePort();
  const ws = workspace(port);
  const inbox = JSON.parse(readFileSync(ws.inbox, "utf8"));
  inbox[0] = { ...inbox[0], id: "dana-1", from: "Dana <dana@acme.io>", fromAddress: "dana@acme.io", subject: "Hawk graph is empty" };
  writeFileSync(ws.inbox, JSON.stringify(inbox));
  const api = await fakeAnthropic();
  closeApi = api.close;
  const env = {
    HOME: ws.home,
    IBO_HOME: ws.iboHome,
    IBO_SECRETS_BACKEND: "file",
    IBO_CLAUDE_BIN: join(ws.home, "no-claude"),
    IBO_NO_AUTO_UPDATE: "1",
    IBO_TEST_INBOX: ws.inbox,
    IBO_BLOCK_LOCAL_MODELS: "1",
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_BASE_URL: api.url,
  };
  daemon = spawn(process.execPath, [CLI, "start"], { env: { ...process.env, ...env } });
  let out = "";
  daemon.stdout!.on("data", (d) => (out += d));
  await expect.poll(() => out, { timeout: 20_000 }).toContain("Watching");

  const page = await launchMenubar(env);
  const card = page.locator(".card");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(card.locator(".assign")).toBeVisible();
  await expect(card.locator(".who")).toHaveText("acme.io");
  await expect(card.locator(".assign-select option").first()).toHaveText("hawk (recommended)");
  await card.locator(".assign-btn").click();

  await expect(page.locator("#banner")).toContainText("now goes to hawk");
  await expect(page.locator(".card .summary")).toHaveText("Open a ticket for the date filter bug", { timeout: 20_000 });
  expect(readFileSync(join(ws.iboHome, "projects.yaml"), "utf8")).toContain("acme.io");
});

test("first run: the setup window walks through Claude, the model and projects, with no Terminal", async () => {
  const port = await freePort();
  const ws = workspace(port);
  // Fresh install: no projects yet. Google is already connected (a sign-in cannot run in CI),
  // and Claude Code once worked in a git repo, which discovery should find.
  writeFileSync(join(ws.iboHome, "projects.yaml"), "projects: []\n");
  mkdirSync(join(ws.iboHome, "secrets"), { recursive: true });
  writeFileSync(join(ws.iboHome, "secrets", "google-refresh-token"), "rt");
  const repo = join(ws.home, "code", "hawk");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const sessions = join(ws.home, ".claude", "projects", "-code-hawk");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "s.jsonl"), JSON.stringify({ cwd: repo, timestamp: new Date().toISOString(), message: { content: [] } }));

  const api = await fakeAnthropic();
  closeApi = api.close;
  const env = {
    HOME: ws.home,
    IBO_HOME: ws.iboHome,
    IBO_SECRETS_BACKEND: "file",
    IBO_CLAUDE_BIN: join(ws.home, "no-claude"),
    IBO_NO_AUTO_UPDATE: "1",
    IBO_SCAN_ROOTS: join(ws.home, "none"),
    IBO_TEST_INBOX: ws.inbox,
    IBO_BLOCK_LOCAL_MODELS: "1",
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_BASE_URL: api.url,
  };
  daemon = spawn(process.execPath, [CLI, "start"], { env: { ...process.env, ...env } });
  let out = "";
  daemon.stdout!.on("data", (d) => (out += d));
  await expect.poll(() => out, { timeout: 20_000 }).toContain("API on");

  app = await electron.launch({ args: [MAIN, "--no-sandbox"], env: { ...process.env, ...env } as Record<string, string> });
  const setup = await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("setup.html"), timeout: 30_000 });

  // Google is connected, so it starts at Claude, which uses the API key here.
  await expect(setup.locator("#claude-ok")).toHaveText("✓ Using your Anthropic API key");
  await setup.locator("#claude-next").click();
  // The organization blocks local models: the step says so and lets you continue.
  await expect(setup.locator("#model-blocked")).toBeVisible();
  await setup.locator("#model-next").click();

  await setup.locator("#scan-btn").click();
  const hawk = setup.locator('.card[data-id="hawk"]');
  await expect(hawk).toBeVisible({ timeout: 30_000 });
  await expect(hawk.locator(".pick")).toBeChecked();
  await hawk.locator(".domains").fill("coleven.com");
  await setup.locator("#manual-add").click();
  await setup.locator(".m-name").fill("Shamir");
  await setup.locator(".m-domains").fill("shamir.org.il");
  await setup.locator("#projects-save").click();

  await expect(setup.locator("#done-summary")).toHaveText("2 projects mapped.");
  const closed = setup.waitForEvent("close");
  await setup.locator("#finish").click();
  await closed;
  const yaml = readFileSync(join(ws.iboHome, "projects.yaml"), "utf8");
  expect(yaml).toContain("coleven.com");
  expect(yaml).toContain("shamir.org.il");
});
