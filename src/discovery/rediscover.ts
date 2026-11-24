import { loadProjects, saveProjects } from "../config/load.js";
import { Project, type ProjectStatus } from "../config/schema.js";
import type { Store } from "../store/db.js";
import { gatherEvidence } from "./onboard.js";
import { proposeDeterministic, type Candidate } from "./propose.js";

export interface Suggestion {
  id: string;
  kind: "new" | "status";
  text: string;
  evidence: string[];
  project?: Project;
  projectId?: string;
  status?: ProjectStatus;
}

const KEY = "suggestions";
const dismissedKey = (id: string) => `suggestion:dismissed:${id}`;

export function listSuggestions(store: Store): Suggestion[] {
  return JSON.parse(store.get(KEY) ?? "[]") as Suggestion[];
}

/** Compares fresh candidates with the saved projects. Pure, so it is easy to test. */
export function diffCandidates(cands: Candidate[], existing: Project[], isDismissed: (id: string) => boolean): Suggestion[] {
  const out: Suggestion[] = [];
  const known = new Set(existing.flatMap((p) => p.match.domains));
  for (const c of cands) {
    const p = c.project;
    const current = existing.find((e) => e.id === p.id);
    if (current) {
      if (current.status !== p.status && p.status !== "live" && current.status === "live") {
        const id = `status:${p.id}:${p.status}`;
        if (!isDismissed(id))
          out.push({ id, kind: "status", projectId: p.id, status: p.status, text: `${current.name ?? p.id} looks ${p.status} (last activity ${p.lastActivity?.slice(0, 10) ?? "unknown"}).`, evidence: c.evidence });
      } else if (current.status !== "live" && p.status === "live") {
        const id = `status:${p.id}:live`;
        if (!isDismissed(id)) out.push({ id, kind: "status", projectId: p.id, status: "live", text: `${current.name ?? p.id} is active again.`, evidence: c.evidence });
      }
      continue;
    }
    if (p.status !== "live" || c.confidence < 0.5) continue;
    if (p.match.domains.some((d) => known.has(d))) continue;
    const id = `new:${p.id}`;
    if (isDismissed(id)) continue;
    out.push({ id, kind: "new", project: p, text: `New project found: ${p.name ?? p.id}.`, evidence: c.evidence });
  }
  return out;
}

/** Background discovery: no questions, no Downloads scan. Results wait in the menu bar. */
export async function rediscover(store: Store, log: (s: string) => void = () => {}): Promise<Suggestion[]> {
  const { evidence, hub } = await gatherEvidence(log);
  try {
    const cands = proposeDeterministic(evidence);
    const suggestions = diffCandidates(cands, loadProjects().projects, (id) => store.get(dismissedKey(id)) !== null);
    store.set(KEY, JSON.stringify(suggestions));
    store.set("rediscover:last", new Date().toISOString());
    store.audit("rediscovered", { suggestions: suggestions.map((s) => s.id) });
    return suggestions;
  } finally {
    await hub.closeAll();
  }
}

export function resolveSuggestion(store: Store, id: string, accept: boolean): { ok: true } | { error: string } {
  const all = listSuggestions(store);
  const s = all.find((x) => x.id === id);
  if (!s) return { error: "not found" };
  if (accept) {
    const file = loadProjects();
    if (s.kind === "new" && s.project) {
      if (!file.projects.some((p) => p.id === s.project!.id)) file.projects.push(Project.parse(s.project));
    } else if (s.kind === "status" && s.projectId && s.status) {
      const p = file.projects.find((x) => x.id === s.projectId);
      if (p) p.status = s.status;
    }
    saveProjects(file);
  } else {
    store.set(dismissedKey(id), new Date().toISOString());
  }
  store.set(KEY, JSON.stringify(all.filter((x) => x.id !== id)));
  store.audit(accept ? "suggestion_accepted" : "suggestion_dismissed", { id });
  return { ok: true };
}

export function rediscoverDue(store: Store, days: number, now = Date.now()): boolean {
  if (days <= 0) return false;
  const last = store.get("rediscover:last");
  return !last || now - Date.parse(last) >= days * 86_400_000;
}
