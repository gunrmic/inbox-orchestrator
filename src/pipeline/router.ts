import type { Project } from "../config/schema.js";
import type { Email } from "../types.js";

export interface RouteResult {
  project: Project | null;
  matchedBy: "sender" | "domain" | "keyword" | null;
  /** True when the match is a dormant or dead project: the agent asks before acting. */
  needsReactivation: boolean;
}

const domainOf = (address: string) => address.toLowerCase().split("@")[1] ?? "";

/**
 * Deterministic routing: exact sender, then domain (including subdomains), then keywords.
 * No model is involved. An email that matches nothing returns project=null and the
 * pipeline runs the small discovery flow instead of guessing.
 */
export function routeEmail(email: Email, projects: Project[]): RouteResult {
  const from = email.fromAddress.toLowerCase();
  const domain = domainOf(from);
  const haystack = `${email.subject}\n${email.body}`.toLowerCase();

  const result = (project: Project, matchedBy: RouteResult["matchedBy"]): RouteResult => ({
    project,
    matchedBy,
    needsReactivation: project.status !== "live",
  });

  const bySender = projects.find((p) => p.match.senders.some((s) => s.toLowerCase() === from));
  if (bySender) return result(bySender, "sender");

  const byDomain = projects.find((p) =>
    p.match.domains.some((d) => {
      const dd = d.toLowerCase().replace(/^@/, "");
      return domain === dd || domain.endsWith(`.${dd}`);
    }),
  );
  if (byDomain) return result(byDomain, "domain");

  // Keywords: the project with the most distinct keyword hits wins. Ties are ambiguous: no match.
  const scored = projects
    .map((p) => ({ p, hits: p.match.keywords.filter((k) => haystack.includes(k.toLowerCase())).length }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scored.length > 0 && (scored.length === 1 || scored[0].hits > scored[1].hits)) {
    return result(scored[0].p, "keyword");
  }

  return { project: null, matchedBy: null, needsReactivation: false };
}
