import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  fakeAnthropic,
  freePort,
  ibo,
  jackEmail,
  makeEnv,
  MCP_SERVER,
  readLines,
  startDaemon,
  waitFor,
  writeJson,
  type Daemon,
  type FakeServer,
} from "./harness.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("daemon end to end", () => {
  it("watches the inbox, runs safe work through a real MCP server, waits for approval on the rest", async () => {
    const anthropic: FakeServer = await fakeAnthropic({
      triage: () => ({ hasAction: true, intents: ["bug_report"], confidence: 0.95 }),
      submit_plan: () => ({
        rationale: "Bug report with a ticket request",
        actions: [
          { action: "prepare_fix", summary: "Checkpoint a fix for the date filter", args: { note: "date filter" } },
          { action: "create_task", summary: "Open a ticket for the date filter bug", args: { title: "Date filter bug" } },
          { action: "publish", summary: "Publish the app", args: {} },
        ],
      }),
    });
    cleanup.push(() => anthropic.close());

    const port = await freePort();
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url, IBO_BLOCK_LOCAL_MODELS: "1" });
    const mcpLog = join(env.home, "mcp-calls.jsonl");
    const inbox = join(env.home, "inbox.json");
    env.vars.IBO_TEST_INBOX = inbox;

    // The user's own MCP server, as Claude Code would have it configured.
    writeJson(join(env.home, ".claude.json"), {
      mcpServers: { apps: { command: process.execPath, args: [MCP_SERVER], env: { FIXTURE_LOG: mcpLog } } },
    });
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ server: { port }, gmail: { pollSeconds: 15 } }));
    writeFileSync(
      join(env.iboHome, "projects.yaml"),
      YAML.stringify({
        projects: [
          {
            id: "hawk",
            match: { senders: ["jack@coleven.com"] },
            playbook: {
              prepare_fix: { kind: "mcp", server: "apps", tool: "create_checkpoint" },
              create_task: { kind: "mcp", server: "apps", tool: "create_ticket" },
              publish: { kind: "mcp", server: "apps", tool: "delete_app" },
            },
          },
        ],
      }),
    );
    // The user even marked the dangerous tool as level 0; the hard floor must still win.
    writeFileSync(
      join(env.iboHome, "tools.yaml"),
      YAML.stringify({ tools: { "apps/create_checkpoint": 1, "apps/create_ticket": 2, "apps/delete_app": 0 } }),
    );
    writeJson(inbox, [jackEmail()]);

    const daemon: Daemon = await startDaemon(env);
    cleanup.push(() => daemon.stop());

    // Level 1 ran on its own through the real MCP server.
    await waitFor(() => readLines(mcpLog).some((c) => c.tool === "create_checkpoint"));
    expect(readLines(mcpLog).find((c) => c.tool === "create_checkpoint").args).toEqual({ note: "date filter" });

    // Level 2 and level 3 are waiting.
    const pending = await waitFor(async () => {
      const r = await ibo(env, ["pending"]);
      return r.stdout.includes("create_task") && r.stdout.includes("publish") ? r.stdout : null;
    });
    expect(pending).toMatch(/L2 hawk\/create_task: Open a ticket/);
    expect(pending).toMatch(/L3 hawk\/publish: Publish the app/);
    expect(readLines(mcpLog).some((c) => c.tool === "create_ticket" || c.tool === "delete_app")).toBe(false);

    const status = await ibo(env, ["status"]);
    expect(status.stdout).toContain("Pending: 2");
    expect(status.stdout).toContain("hawk (live)");

    // Approve the ticket from the CLI: it runs through the MCP server.
    const ticketId = pending.match(/#(\d+) L2/)![1];
    const approved = await ibo(env, ["approve", ticketId]);
    expect(approved.stdout).toContain("done: ticket opened: Date filter bug");
    expect(readLines(mcpLog).some((c) => c.tool === "create_ticket")).toBe(true);

    // Reject the dangerous one: it never runs.
    const publishId = pending.match(/#(\d+) L3/)![1];
    expect((await ibo(env, ["reject", publishId])).stdout).toContain("Rejected");
    expect(readLines(mcpLog).some((c) => c.tool === "delete_app")).toBe(false);
    expect((await ibo(env, ["pending"])).stdout).toContain("Nothing waiting");

    // Kill switch persists and shows in status.
    expect((await ibo(env, ["kill", "on"])).stdout).toContain("ON");
    expect((await ibo(env, ["status"])).stdout).toContain("KILL SWITCH ON");
    expect((await ibo(env, ["kill", "off"])).stdout).toContain("off");

    // Promote, then stop cleanly.
    expect((await ibo(env, ["promote", "hawk", "create_task"])).stdout).toContain("ok");
    expect(YAML.parse((await import("node:fs")).readFileSync(join(env.iboHome, "projects.yaml"), "utf8")).projects[0].autonomy.create_task).toBe("auto");
    expect(await daemon.stop()).toBe(0);
    cleanup.length = 0;
  });

  it("with the kill switch on, nothing executes, not even level 1", async () => {
    const anthropic = await fakeAnthropic({
      triage: () => ({ hasAction: true, intents: ["bug_report"], confidence: 0.95 }),
      submit_plan: () => ({ rationale: "r", actions: [{ action: "prepare_fix", summary: "Checkpoint", args: {} }] }),
    });
    cleanup.push(() => anthropic.close());
    const port = await freePort();
    const env = makeEnv({ ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: anthropic.url, IBO_BLOCK_LOCAL_MODELS: "1" });
    const mcpLog = join(env.home, "mcp-calls.jsonl");
    env.vars.IBO_TEST_INBOX = join(env.home, "inbox.json");
    writeJson(join(env.home, ".claude.json"), { mcpServers: { apps: { command: process.execPath, args: [MCP_SERVER], env: { FIXTURE_LOG: mcpLog } } } });
    writeFileSync(join(env.iboHome, "settings.yaml"), YAML.stringify({ server: { port }, killSwitch: true }));
    writeFileSync(
      join(env.iboHome, "projects.yaml"),
      YAML.stringify({ projects: [{ id: "hawk", match: { senders: ["jack@coleven.com"] }, playbook: { prepare_fix: { kind: "mcp", server: "apps", tool: "create_checkpoint" } } }] }),
    );
    writeFileSync(join(env.iboHome, "tools.yaml"), YAML.stringify({ tools: { "apps/create_checkpoint": 1 } }));
    writeJson(env.vars.IBO_TEST_INBOX, [jackEmail()]);

    const daemon = await startDaemon(env);
    cleanup.push(() => daemon.stop());
    const pending = await waitFor(async () => {
      const r = await ibo(env, ["pending"]);
      return r.stdout.includes("prepare_fix") ? r.stdout : null;
    });
    expect(pending).toContain("Kill switch is on");
    expect(readLines(mcpLog)).toEqual([]);
  });
});
