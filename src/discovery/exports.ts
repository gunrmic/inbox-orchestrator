import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Chats in claude.ai, ChatGPT and Gemini live on their servers, not on the Mac. Their official
 * data exports do reach the Mac, as a ZIP. We read only names, descriptions and dates.
 */
export interface AssistantExport {
  source: "Claude" | "ChatGPT";
  /** Claude Projects: the user's own grouping, the strongest signal. */
  projects: { name: string; description: string; lastActivity: string }[];
  /** Conversation titles, used as supporting evidence only. */
  titles: { title: string; lastActivity: string }[];
}

function readMember(path: string, member: string): string | null {
  if (statSync(path).isDirectory()) {
    const p = join(path, member);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  if (path.endsWith(".zip")) {
    try {
      return execFileSync("unzip", ["-p", path, member], { maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8") || null;
    } catch {
      return null;
    }
  }
  return path.endsWith(member) ? readFileSync(path, "utf8") : null;
}

const iso = (v: unknown): string => {
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return "";
};

export function readAssistantExport(path: string): AssistantExport {
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const projectsRaw = readMember(path, "projects.json");
  const convRaw = readMember(path, "conversations.json");
  if (!projectsRaw && !convRaw) throw new Error(`${path} is not a Claude or ChatGPT data export (no conversations.json).`);

  const convs: any[] = convRaw ? JSON.parse(convRaw) : [];
  // ChatGPT conversations carry `mapping` and epoch-seconds times; Claude's carry `chat_messages`.
  const isChatGPT = convs.some((c) => c && "mapping" in c);
  const projects = (projectsRaw ? (JSON.parse(projectsRaw) as any[]) : [])
    .filter((p) => p?.name && !p.is_starter_project)
    .map((p) => ({ name: String(p.name), description: String(p.description ?? "").slice(0, 300), lastActivity: iso(p.updated_at ?? p.created_at) }));
  const titles = convs
    .map((c) => ({ title: String(c?.name ?? c?.title ?? "").trim(), lastActivity: iso(c?.updated_at ?? c?.update_time ?? c?.create_time) }))
    .filter((t) => t.title)
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return { source: isChatGPT ? "ChatGPT" : "Claude", projects, titles };
}

/**
 * Claude and ChatGPT exports land in ~/Downloads as a ZIP with conversations.json inside.
 * Only recent ZIPs are opened, and only their file list is read here.
 */
export function findExports(dir = join(process.env.HOME ?? "", "Downloads"), maxAgeDays = 60): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".zip"))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        const st = statSync(p);
        return st.mtimeMs >= cutoff && st.size < 4 * 1024 ** 3;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, 30)
    .filter((p) => {
      try {
        const list = execFileSync("unzip", ["-Z1", p], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString();
        return list.split("\n").some((l) => l.trim() === "conversations.json");
      } catch {
        return false;
      }
    });
}
