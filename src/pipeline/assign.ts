import { loadProjects, saveProjects } from "../config/load.js";
import { Project } from "../config/schema.js";
import { nameTokens, orgOfDomain } from "../discovery/propose.js";
import { slugify } from "../executors/claude-code.js";
import { PERSONAL_DOMAINS } from "../gmail/client.js";
import type { Email } from "../types.js";

export interface AssignInfo {
  domain: string;
  sender: string;
  /** "domain" for a company address, "sender" for a personal one (gmail.com and friends). */
  scope: "domain" | "sender";
  /** Existing projects that look related, best first. */
  suggestions: string[];
  /** Name for a new project if none fits. */
  newName: string;
}

/**
 * For mail from an unmapped sender: which project is it probably about? Looks at the
 * sender's organisation, display name and the subject, against project names and keywords.
 */
export function suggestAssignment(email: Email, projects: Project[]): AssignInfo {
  const sender = email.fromAddress.toLowerCase();
  const domain = sender.split("@")[1] ?? "";
  const personal = PERSONAL_DOMAINS.has(domain);
  const org = personal ? "" : orgOfDomain(domain);
  const words = new Set(nameTokens(`${org} ${email.from} ${email.subject}`));
  const scored = projects
    .map((p) => {
      const names = [p.id, p.name ?? "", ...p.match.keywords].flatMap(nameTokens);
      const hits = names.filter((n) => words.has(n)).length;
      return { id: p.id, hits, live: p.status === "live" ? 1 : 0 };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.live - a.live);
  const display = email.from.replace(/<.*>/, "").replace(/"/g, "").trim();
  return {
    domain,
    sender,
    scope: personal ? "sender" : "domain",
    suggestions: scored.slice(0, 3).map((s) => s.id),
    newName: personal ? display || sender.split("@")[0] : org,
  };
}

export interface AssignRequest {
  /** Existing project id, or "new". */
  project: string;
  /** Name for a new project. */
  name?: string;
  scope: "domain" | "sender";
  domain: string;
  sender: string;
}

/** Adds the sender or domain to a project's match rules (creating the project if asked). Returns its id. */
export function applyAssignment(req: AssignRequest): string {
  const file = loadProjects();
  let project: Project | undefined;
  if (req.project === "new") {
    const name = (req.name ?? req.domain).trim();
    let id = slugify(name) || "project";
    while (file.projects.some((p) => p.id === id)) id = `${id}-2`;
    project = Project.parse({ id, name, status: "live", lastActivity: new Date().toISOString(), playbook: { create_reminder: { kind: "reminder" } } });
    file.projects.push(project);
  } else {
    project = file.projects.find((p) => p.id === req.project);
    if (!project) throw new Error(`Unknown project ${req.project}`);
  }
  const list = req.scope === "sender" ? project.match.senders : project.match.domains;
  const value = req.scope === "sender" ? req.sender : req.domain;
  if (value && !list.includes(value)) list.push(value);
  saveProjects(file);
  return project.id;
}
