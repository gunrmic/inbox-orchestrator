// A small but real MCP server over stdio, used by integration and e2e tests.
// It imitates an app platform: a read-only listing, a reversible checkpoint, a destructive delete,
// and a tool that fails. Every call is appended to $FIXTURE_LOG so tests can assert what ran.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (tool, args) => {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ tool, args }) + "\n");
};
const text = (t) => ({ content: [{ type: "text", text: t }] });

const server = new McpServer({ name: "fixture-apps", version: "1.0.0" });

server.registerTool(
  "list_apps",
  { description: "List the user's apps", annotations: { readOnlyHint: true } },
  async () => {
    log("list_apps", {});
    return text(JSON.stringify([{ id: "app-hawk", name: "Hawk Graph", updated_at: "2026-11-23T09:00:00Z" }]));
  },
);

server.registerTool(
  "create_checkpoint",
  { description: "Save a checkpoint of an app", inputSchema: { appId: z.string().optional(), note: z.string().optional() } },
  async (args) => {
    log("create_checkpoint", args);
    return text(`checkpoint created for ${args.appId ?? "default"}: ${args.note ?? ""}`);
  },
);

server.registerTool(
  "create_ticket",
  { description: "Open a ticket visible to the client", inputSchema: { title: z.string().optional() } },
  async (args) => {
    log("create_ticket", args);
    return text(`ticket opened: ${args.title ?? ""}`);
  },
);

server.registerTool(
  "delete_app",
  { description: "Delete an app", inputSchema: { appId: z.string() }, annotations: { destructiveHint: true } },
  async (args) => {
    log("delete_app", args);
    return text("deleted");
  },
);

server.registerTool("fail_tool", { description: "Always fails" }, async () => {
  log("fail_tool", {});
  return { isError: true, content: [{ type: "text", text: "something broke" }] };
});

await server.connect(new StdioServerTransport());
