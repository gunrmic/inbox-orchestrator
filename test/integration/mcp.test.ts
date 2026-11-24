import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpHub } from "../../src/executors/mcp-hub.js";
import { probeServer } from "../../src/discovery/probe.js";
import { DefaultExecutor } from "../../src/executors/index.js";
import type { DiscoveredServer } from "../../src/discovery/mcp-configs.js";

const SERVER = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));

function setup() {
  const log = join(mkdtempSync(join(tmpdir(), "ibo-mcp-")), "calls.jsonl");
  const servers: DiscoveredServer[] = [
    { name: "apps", config: { type: "stdio", command: process.execPath, args: [SERVER], env: { FIXTURE_LOG: log } }, source: "test", scope: null },
  ];
  const hub = new McpHub(servers);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { hub, calls };
}

let hub: McpHub | null = null;
afterEach(async () => {
  await hub?.closeAll();
  hub = null;
});

describe("McpHub against a real stdio MCP server", () => {
  it("lists tools with their annotations", async () => {
    const s = setup();
    hub = s.hub;
    const tools = await hub.listTools("apps");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["create_checkpoint", "create_ticket", "delete_app", "fail_tool", "list_apps"]);
    expect(byName.list_apps.annotations.readOnlyHint).toBe(true);
    expect(byName.delete_app.annotations.destructiveHint).toBe(true);
  });

  it("calls a tool and returns its text", async () => {
    const s = setup();
    hub = s.hub;
    expect(await hub.callTool("apps", "create_checkpoint", { appId: "app-hawk", note: "fix" })).toBe("checkpoint created for app-hawk: fix");
    expect(s.calls()).toEqual([{ tool: "create_checkpoint", args: { appId: "app-hawk", note: "fix" } }]);
  });

  it("turns tool errors into exceptions", async () => {
    const s = setup();
    hub = s.hub;
    await expect(hub.callTool("apps", "fail_tool", {})).rejects.toThrow("something broke");
  });

  it("explains unknown servers", async () => {
    hub = new McpHub([]);
    await expect(hub.callTool("nope", "x", {})).rejects.toThrow(/not configured/);
  });

  it("runs an MCP playbook step through the executor", async () => {
    const s = setup();
    hub = s.hub;
    const out = await new DefaultExecutor(hub).run({
      record: { id: 1, emailId: "e", projectId: "p", action: "prepare_fix", summary: "s", args: { note: "n" }, risk: 1, decision: "execute", reason: "", status: "executing", result: null, createdAt: "", updatedAt: "" },
      step: { kind: "mcp", server: "apps", tool: "create_checkpoint", defaults: { appId: "app-hawk" } },
      project: null,
      email: null,
    });
    expect(out).toBe("checkpoint created for app-hawk: n");
  });
});

describe("discovery probe", () => {
  it("calls only read-only listing tools and never destructive ones", async () => {
    const s = setup();
    hub = s.hub;
    const probe = await probeServer(hub, "apps");
    expect(probe.reachable).toBe(true);
    expect(probe.samples.map((x) => x.tool)).toEqual(["list_apps"]);
    expect(probe.samples[0].output).toContain("Hawk Graph");
    expect(s.calls().map((c: { tool: string }) => c.tool)).toEqual(["list_apps"]);
  });

  it("reports unreachable servers without throwing", async () => {
    hub = new McpHub([{ name: "dead", config: { type: "stdio", command: "/nonexistent/binary", args: [] }, source: "t", scope: null }]);
    const probe = await probeServer(hub, "dead");
    expect(probe.reachable).toBe(false);
    expect(probe.error).toBeTruthy();
  });
});
