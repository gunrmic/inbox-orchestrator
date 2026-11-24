import type { McpHub, HubTool } from "../executors/mcp-hub.js";
import { isDiscoverySafe } from "../policy/risk.js";

export interface ServerProbe {
  server: string;
  reachable: boolean;
  error?: string;
  tools: HubTool[];
  /** Output of a few read-only listing calls, trimmed. Used to find apps, boards, repos and their dates. */
  samples: { tool: string; output: string }[];
}

/**
 * Connects to one MCP server and calls only read-only listing tools that need no arguments.
 * Nothing that can change state is called during discovery.
 */
export async function probeServer(hub: McpHub, server: string, maxCalls = 2): Promise<ServerProbe> {
  try {
    const tools = await hub.listTools(server);
    const listers = tools.filter((t) => isDiscoverySafe(t.name, t.annotations) && /^(list|get_?user|whoami|get_?me)/i.test(t.name));
    const samples: ServerProbe["samples"] = [];
    for (const t of listers.slice(0, maxCalls)) {
      try {
        const output = await hub.callTool(server, t.name, {});
        samples.push({ tool: t.name, output: output.slice(0, 4000) });
      } catch {
        /* tool needs arguments; skip */
      }
    }
    return { server, reachable: true, tools, samples };
  } catch (err) {
    return { server, reachable: false, error: err instanceof Error ? err.message : String(err), tools: [], samples: [] };
  }
}
