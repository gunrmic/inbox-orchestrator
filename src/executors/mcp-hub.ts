import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { DiscoveredServer } from "../discovery/mcp-configs.js";
import type { ToolAnnotations } from "../policy/risk.js";

export interface HubTool {
  server: string;
  name: string;
  description: string;
  annotations: ToolAnnotations;
}

/** Connects lazily to the user's own MCP servers and calls their tools. */
export class McpHub {
  private clients = new Map<string, Client>();

  constructor(private readonly servers: DiscoveredServer[]) {}

  names(): string[] {
    return this.servers.map((s) => s.name);
  }

  private async client(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const server = this.servers.find((s) => s.name === name);
    if (!server) throw new Error(`MCP server "${name}" is not configured on this Mac.`);

    const client = new Client({ name: "inbox-orchestrator", version: "0.1.0" });
    const c = server.config;
    const transport =
      c.type === "stdio"
        ? new StdioClientTransport({
            command: c.command,
            args: c.args,
            env: { ...(process.env as Record<string, string>), ...(c.env ?? {}) },
            stderr: "ignore",
          })
        : c.type === "sse"
          ? new SSEClientTransport(new URL(c.url), { requestInit: { headers: c.headers } })
          : new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } });
    await client.connect(transport);
    this.clients.set(name, client);
    return client;
  }

  async listTools(server: string): Promise<HubTool[]> {
    const client = await this.client(server);
    const res = await client.listTools();
    return res.tools.map((t) => ({
      server,
      name: t.name,
      description: t.description ?? "",
      annotations: (t.annotations ?? {}) as ToolAnnotations,
    }));
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.client(server);
    const res = await client.callTool({ name: tool, arguments: args });
    const parts = Array.isArray(res.content) ? res.content : [];
    const text = parts
      .map((p: any) => (p.type === "text" ? p.text : `[${p.type}]`))
      .join("\n");
    if (res.isError) throw new Error(text || `Tool ${server}/${tool} returned an error.`);
    return text;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
