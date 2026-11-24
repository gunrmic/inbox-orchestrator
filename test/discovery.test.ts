import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanClaudeSessions, serverFromToolName } from "../src/discovery/claude-sessions.js";
import { discoverMcpServers } from "../src/discovery/mcp-configs.js";
import { newest, statusFrom } from "../src/discovery/activity.js";
import { proposeDeterministic } from "../src/discovery/propose.js";

const day = 86_400_000;

describe("activity status", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  it("classifies by the newest signal", () => {
    expect(statusFrom(new Date(now - 3 * day).toISOString(), now)).toBe("live");
    expect(statusFrom(new Date(now - 90 * day).toISOString(), now)).toBe("dormant");
    expect(statusFrom(new Date(now - 400 * day).toISOString(), now)).toBe("dead");
    expect(statusFrom(null, now)).toBe("dead");
  });
  it("picks the newest date and ignores junk", () => {
    expect(newest("2026-01-01", null, "bad", "2026-06-01")).toBe("2026-06-01");
  });
});

describe("Claude Code sessions", () => {
  it("extracts MCP server names from tool names", () => {
    expect(serverFromToolName("mcp__Base44__read_file")).toBe("Base44");
    expect(serverFromToolName("Read")).toBeNull();
  });

  it("aggregates folders and MCP usage from transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "ibo-sessions-"));
    mkdirSync(join(root, "-Users-omer-code-hawk"));
    const lines = [
      { cwd: "/Users/omer/code/hawk", timestamp: "2026-11-20T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } },
      { cwd: "/Users/omer/code/hawk", timestamp: "2026-11-21T10:00:00Z", message: { content: [{ type: "tool_use", name: "mcp__Base44__read_file" }] } },
      { cwd: "/Users/omer/code/hawk", timestamp: "2026-11-22T10:00:00Z", message: { content: [{ type: "tool_use", name: "mcp__Base44__grep" }, { type: "tool_use", name: "Bash" }] } },
      "not json",
    ];
    writeFileSync(join(root, "-Users-omer-code-hawk", "s1.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
    const scan = await scanClaudeSessions(root, 100000);
    expect(scan.folders).toHaveLength(1);
    expect(scan.folders[0].lastActivity).toBe("2026-11-22T10:00:00Z");
    expect(scan.folders[0].servers.Base44).toBe(2);
    expect(scan.servers[0]).toMatchObject({ server: "Base44", calls: 2, lastUsed: "2026-11-22T10:00:00Z" });

    const candidates = proposeDeterministic({ sessions: scan, repos: [], probes: [], senders: [] }, Date.parse("2026-11-24T00:00:00Z"));
    expect(candidates[0].project.status).toBe("live");
    expect(candidates[0].evidence.join(" ")).toContain("Base44 (2 calls)");
  });
});

describe("MCP configs", () => {
  it("reads user, project and desktop scopes and de-duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "ibo-mcp-"));
    const proj = join(dir, "proj");
    mkdirSync(proj);
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { type: "http", url: "https://example.com/mcp" } } }));
    writeFileSync(
      join(dir, "claude.json"),
      JSON.stringify({
        mcpServers: { base44: { command: "npx", args: ["-y", "base44-mcp"] } },
        projects: { [proj]: { mcpServers: { base44: { command: "other" }, linear: { type: "sse", url: "https://l.example/sse" } } } },
      }),
    );
    writeFileSync(join(dir, "desktop.json"), JSON.stringify({ mcpServers: { calendar: { command: "uvx", args: ["gcal-mcp"] } } }));
    const servers = discoverMcpServers({ claudeJson: join(dir, "claude.json"), desktopConfig: join(dir, "desktop.json") });
    expect(servers.map((s) => s.name).sort()).toEqual(["base44", "calendar", "jira", "linear"]);
    expect(servers.find((s) => s.name === "base44")?.config).toMatchObject({ type: "stdio", command: "npx" });
    expect(servers.find((s) => s.name === "linear")?.config).toMatchObject({ type: "sse" });
  });
});
