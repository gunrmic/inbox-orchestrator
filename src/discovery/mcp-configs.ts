import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type McpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface DiscoveredServer {
  name: string;
  config: McpServerConfig;
  /** Where the definition came from, for display. */
  source: string;
  /** Project folder for project-scoped servers in ~/.claude.json, else null (user scope). */
  scope: string | null;
}

function readJson(file: string): any {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function normalize(raw: any): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.url === "string") {
    return { type: raw.type === "sse" ? "sse" : "http", url: raw.url, headers: raw.headers };
  }
  if (typeof raw.command === "string") {
    return { type: "stdio", command: raw.command, args: Array.isArray(raw.args) ? raw.args : [], env: raw.env };
  }
  return null;
}

function collect(servers: any, source: string, scope: string | null, out: DiscoveredServer[]) {
  if (!servers || typeof servers !== "object") return;
  for (const [name, raw] of Object.entries(servers)) {
    const config = normalize(raw);
    if (config) out.push({ name, config, source, scope });
  }
}

export interface McpConfigLocations {
  claudeJson: string;
  desktopConfig: string;
}

export function defaultLocations(home = homedir()): McpConfigLocations {
  const desktop =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  return { claudeJson: join(home, ".claude.json"), desktopConfig: desktop };
}

/**
 * Reads every MCP server the user already configured for Claude Code (user and project
 * scope, plus .mcp.json in known project folders) and Claude Desktop.
 * Servers that exist only as claude.ai connectors are not visible from the Mac.
 */
export function discoverMcpServers(loc: McpConfigLocations = defaultLocations()): DiscoveredServer[] {
  const out: DiscoveredServer[] = [];
  const claude = readJson(loc.claudeJson);
  if (claude) {
    collect(claude.mcpServers, "~/.claude.json", null, out);
    for (const [folder, proj] of Object.entries<any>(claude.projects ?? {})) {
      collect(proj?.mcpServers, `~/.claude.json (${folder})`, folder, out);
      const dotMcp = readJson(join(folder, ".mcp.json"));
      collect(dotMcp?.mcpServers, `${folder}/.mcp.json`, folder, out);
    }
  }
  const desktop = readJson(loc.desktopConfig);
  collect(desktop?.mcpServers, "Claude Desktop", null, out);

  // De-duplicate by name, keeping the first (user scope wins over project scope).
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}
