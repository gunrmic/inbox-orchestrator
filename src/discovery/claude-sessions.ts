import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FolderUsage {
  folder: string;
  lastActivity: string;
  sessions: number;
  /** MCP server name -> number of tool calls in this folder. */
  servers: Record<string, number>;
  /** Where the folder was seen: Claude Code, Codex, Cursor, VS Code, git scan. */
  via?: string[];
  /** Newest file modification in the folder (ignoring dependencies and build output). */
  lastFileChange?: string | null;
}

export interface ServerUsage {
  server: string;
  lastUsed: string;
  calls: number;
  folders: string[];
}

export interface SessionScan {
  folders: FolderUsage[];
  servers: ServerUsage[];
}

/** mcp__<server>__<tool> -> server */
export function serverFromToolName(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  return idx > 0 ? rest.slice(0, idx) : null;
}

const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a > b ? a : b);

/** Parse one Claude Code session transcript (JSONL). Exported for tests. */
export async function scanTranscript(
  file: string,
  acc: { folders: Map<string, FolderUsage>; servers: Map<string, ServerUsage> },
): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let folderSeen: string | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd: string | undefined = entry.cwd;
    const ts: string | undefined = entry.timestamp;
    if (!cwd) continue;

    let folder = acc.folders.get(cwd);
    if (!folder) {
      folder = { folder: cwd, lastActivity: ts ?? "", sessions: 0, servers: {} };
      acc.folders.set(cwd, folder);
    }
    if (folderSeen !== cwd) {
      folder.sessions += 1;
      folderSeen = cwd;
    }
    folder.lastActivity = later(folder.lastActivity, ts) ?? "";

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const server = serverFromToolName(block.name);
      if (!server) continue;
      folder.servers[server] = (folder.servers[server] ?? 0) + 1;
      let s = acc.servers.get(server);
      if (!s) {
        s = { server, lastUsed: ts ?? "", calls: 0, folders: [] };
        acc.servers.set(server, s);
      }
      s.calls += 1;
      s.lastUsed = later(s.lastUsed, ts) ?? "";
      if (!s.folders.includes(cwd)) s.folders.push(cwd);
    }
  }
}

/**
 * Reads Claude Code session transcripts in ~/.claude/projects. Each line records the
 * working folder, a timestamp and any tool calls, which tells us which MCP servers are
 * actually used, in which project, and how recently.
 */
export async function scanClaudeSessions(
  root = join(homedir(), ".claude", "projects"),
  maxAgeDays = 365,
): Promise<SessionScan> {
  const acc = { folders: new Map<string, FolderUsage>(), servers: new Map<string, ServerUsage>() };
  if (!existsSync(root)) return { folders: [], servers: [] };
  const cutoff = Date.now() - maxAgeDays * 86_400_000;

  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(full, f);
      if (statSync(file).mtimeMs < cutoff) continue;
      await scanTranscript(file, acc);
    }
  }
  return {
    folders: [...acc.folders.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    servers: [...acc.servers.values()].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed)),
  };
}
