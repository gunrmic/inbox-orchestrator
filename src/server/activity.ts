import type { Store } from "../store/db.js";

export type Tone = "done" | "skip" | "wait" | "error" | "info";

export interface ActivityItem {
  at: string;
  tone: Tone;
  title: string;
  detail: string;
}

const short = (s: unknown, n = 70) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The audit log in words a person reads in the menu bar: what the agent did with each
 * email, what waits for you, what failed. Internal steps (the plan itself) are left out.
 */
export function describe(store: Store, e: { at: string; kind: string; detail: string; emailId: string | null; actionId: number | null }): ActivityItem | null {
  let d: Record<string, any> = {};
  try {
    d = JSON.parse(e.detail) ?? {};
  } catch {
    /* keep empty */
  }
  const action = e.actionId ? store.getAction(e.actionId) : null;
  const item = (tone: Tone, title: string, detail = ""): ActivityItem => ({ at: e.at, tone, title, detail });
  switch (e.kind) {
    case "filter":
      return d.hasAction
        ? item("info", `New email: “${short(d.subject)}”`, `From ${d.from ?? "unknown"} · needs action`)
        : item("skip", `Skipped: “${short(d.subject)}”`, `No action needed · ${String(d.model ?? "").startsWith("ollama") ? "sorted on this Mac" : "sorted by Claude"}`);
    case "decision":
      if (d.kind === "suggest") return item("wait", `Waiting for you: ${short(action?.summary ?? d.action)}`, short(d.reason, 90));
      if (d.kind === "deny") return item("info", `Not allowed: ${short(action?.summary ?? d.action)}`, short(d.reason, 90));
      return null;
    case "executed":
      return item("done", short(action?.summary ?? d.action), short(String(d.result ?? "").split("\n")[0], 90));
    case "failed":
      return item("error", `Failed: ${short(action?.summary ?? d.action)}`, short(d.error, 90));
    case "approved":
      return item("info", `You approved: ${short(action?.summary ?? d.action)}`, d.edited ? "with edits" : "");
    case "rejected":
      return item("info", `You dismissed: ${short(action?.summary ?? d.action)}`);
    case "assigned":
      return item("info", `Mail from ${d.scope === "sender" ? d.sender : d.domain} now goes to ${d.projectId}`);
    case "killswitch":
      return item("info", d.on ? "Paused: nothing runs, everything becomes a card" : "Resumed");
    case "model_fallback":
      return item("info", "Used Claude instead of the local model", short(d.reason, 90));
    case "error":
      return item("error", "Could not process an email", short(d.error, 90));
    case "rediscovered":
      return Array.isArray(d.suggestions) && d.suggestions.length ? item("info", `Weekly discovery: ${d.suggestions.length} suggestion(s)`) : null;
    case "update":
      return d.updated ? item("info", "Updated to a new version") : d.error ? item("error", "Update failed, kept the current version", short(d.error, 90)) : null;
    case "setup_projects":
      return item("info", `Projects saved: ${(d.saved ?? []).join(", ")}`);
    case "daemon":
      return item("info", short(d.message, 90));
    default:
      return null;
  }
}

export function activity(store: Store, limit = 60): ActivityItem[] {
  return store
    .recentAudit(limit * 3)
    .map((e) => describe(store, e))
    .filter((x): x is ActivityItem => x !== null)
    .slice(0, limit);
}
