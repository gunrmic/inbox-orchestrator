import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A folder some other coding tool worked in, with the newest activity it recorded. */
export interface ToolFolder {
  folder: string;
  lastActivity: string;
  sessions: number;
  via: string;
}

function walkFiles(dir: string, ext: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, ext, out, depth + 1);
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

function merge(map: Map<string, ToolFolder>, folder: string, ts: string, via: string) {
  const f = map.get(folder) ?? { folder, lastActivity: ts, sessions: 0, via };
  f.sessions += 1;
  if (ts > f.lastActivity) f.lastActivity = ts;
  map.set(folder, f);
}

/** OpenAI Codex CLI keeps one JSONL per session under ~/.codex/sessions; the first lines carry the cwd. */
export async function scanCodexSessions(root = join(homedir(), ".codex", "sessions"), maxAgeDays = 365): Promise<ToolFolder[]> {
  const map = new Map<string, ToolFolder>();
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  for (const file of walkFiles(root, ".jsonl")) {
    const st = statSync(file);
    if (st.mtimeMs < cutoff) continue;
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    let lines = 0;
    for await (const line of rl) {
      if (++lines > 20) break;
      try {
        const e = JSON.parse(line);
        const cwd: string | undefined = e.payload?.cwd ?? e.cwd;
        if (cwd) {
          merge(map, cwd, new Date(st.mtimeMs).toISOString(), "Codex");
          break;
        }
      } catch {
        /* not JSON */
      }
    }
    rl.close();
  }
  return [...map.values()];
}

/** Cursor, VS Code and Windsurf record every opened folder in workspaceStorage/<hash>/workspace.json. */
export function editorStorageRoots(home = homedir()): { root: string; via: string }[] {
  const base = join(home, "Library", "Application Support");
  return [
    { root: join(base, "Cursor", "User", "workspaceStorage"), via: "Cursor" },
    { root: join(base, "Code", "User", "workspaceStorage"), via: "VS Code" },
    { root: join(base, "Windsurf", "User", "workspaceStorage"), via: "Windsurf" },
  ];
}

export function scanEditorWorkspaces(roots = editorStorageRoots(), maxAgeDays = 365): ToolFolder[] {
  const map = new Map<string, ToolFolder>();
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  for (const { root, via } of roots) {
    if (!existsSync(root)) continue;
    for (const hash of readdirSync(root)) {
      const ws = join(root, hash, "workspace.json");
      if (!existsSync(ws)) continue;
      try {
        const uri: string | undefined = JSON.parse(readFileSync(ws, "utf8")).folder;
        if (!uri?.startsWith("file://")) continue;
        const folder = fileURLToPath(uri);
        const db = join(root, hash, "state.vscdb");
        const mtime = statSync(existsSync(db) ? db : ws).mtimeMs;
        if (mtime < cutoff || !existsSync(folder)) continue;
        merge(map, folder, new Date(mtime).toISOString(), via);
      } catch {
        /* unreadable entry */
      }
    }
  }
  return [...map.values()];
}
