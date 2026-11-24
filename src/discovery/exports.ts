import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
