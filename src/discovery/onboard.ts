import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import pc from "picocolors";
import { loadProjects, loadTools, saveProjects, saveTools } from "../config/load.js";
import { ensureHome, paths } from "../config/paths.js";
import { RISK_LABELS, type Project, type RiskLevel } from "../config/schema.js";
import { McpHub } from "../executors/mcp-hub.js";
import type { ModelRouter } from "../models/router.js";
import { suggestRisk } from "../policy/risk.js";
import { authorizedClient } from "../gmail/auth.js";
import { GmailSource, PERSONAL_DOMAINS } from "../gmail/client.js";
import { meetingStats } from "../gmail/calendar.js";
import { lastFileChange, newest, repoInfo } from "./activity.js";
import { scanCodexSessions, scanEditorWorkspaces } from "./editors.js";
import { findExports, readAssistantExport, type AssistantExport } from "./exports.js";
import { scanClaudeSessions } from "./claude-sessions.js";
import { findRepos } from "./repos.js";
import { discoverMcpServers } from "./mcp-configs.js";
import { probeServer } from "./probe.js";
import { slugify } from "../executors/claude-code.js";
import { proposeDeterministic, proposeWithModel, type Candidate, type Evidence } from "./propose.js";

const RECOMMENDED = pc.green(" (recommended)");

export async function gatherEvidence(log: (s: string) => void, imports: string[] = []): Promise<{ evidence: Evidence; hub: McpHub }> {
  log("Reading MCP server configs (Claude Code, Claude Desktop)...");
  const servers = discoverMcpServers();
  log(`  ${servers.length} servers configured`);

  log("Scanning Claude Code sessions for project folders and MCP usage...");
  const sessions = await scanClaudeSessions();
  log(`  ${sessions.folders.length} folders, ${sessions.servers.length} MCP servers used`);

  for (const f of sessions.folders) f.via = ["Claude Code"];
  const byFolder = new Map(sessions.folders.map((f) => [f.folder, f]));
  const add = (folder: string, lastActivity: string, via: string, count = 0) => {
    const f = byFolder.get(folder);
    if (f) {
      if (!f.via?.includes(via)) f.via = [...(f.via ?? []), via];
      if (lastActivity > f.lastActivity) f.lastActivity = lastActivity;
      return;
    }
    const nf = { folder, lastActivity, sessions: count, servers: {}, via: [via] };
    byFolder.set(folder, nf);
    sessions.folders.push(nf);
  };

  log("Reading Codex sessions and Cursor / VS Code / Windsurf workspaces...");
  const codex = await scanCodexSessions();
  const editors = scanEditorWorkspaces();
  for (const t of [...codex, ...editors]) add(t.folder, t.lastActivity, t.via, t.sessions);
  log(`  ${codex.length} Codex folders, ${editors.length} editor folders`);

  log("Looking for git repos in your code folders (~/projects, ~/apps, ~/code, ...)...");
  const scanned = findRepos().filter((f) => !byFolder.has(f));
  for (const f of scanned) add(f, "", "git scan");
  log(`  ${scanned.length} more repos`);

  log("Checking git activity and when files last changed...");
  const repos = await Promise.all(sessions.folders.map((f) => repoInfo(f.folder)));
  const cutoffIso = new Date(Date.now() - 180 * 86_400_000).toISOString();
  sessions.folders = sessions.folders.filter((f) => {
    f.lastFileChange = lastFileChange(f.folder);
    const repo = repos.find((r) => r.folder === f.folder);
    const last = newest(f.lastActivity, repo?.lastCommit, f.lastFileChange) ?? "";
    if (!f.lastActivity) f.lastActivity = newest(repo?.lastCommit, f.lastFileChange) ?? "";
    // Folders that only an editor or a scan knows about count only if something changed recently.
    return f.via?.includes("Claude Code") || last >= cutoffIso;
  });
  sessions.folders.sort((a, b) => (newest(b.lastActivity, b.lastFileChange) ?? "").localeCompare(newest(a.lastActivity, a.lastFileChange) ?? ""));
  log(`  ${sessions.folders.length} folders with recent activity`);

  const assistants: AssistantExport[] = [];
  for (const file of imports) {
    try {
      const a = readAssistantExport(file.replace(/^~/, process.env.HOME ?? ""));
      assistants.push(a);
      log(`  ${a.source} export: ${a.projects.length} projects, ${a.titles.length} chats`);
    } catch (err) {
      log(pc.yellow(`  ${file}: ${err instanceof Error ? err.message : err}`));
    }
  }

  // Probe only servers that are configured AND were used in the last 180 days.
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const used = new Set(sessions.servers.filter((s) => s.lastUsed >= cutoff).map((s) => s.server));
  const hub = new McpHub(servers);
  const toProbe = servers.filter((s) => used.has(s.name));
  log(`Probing ${toProbe.length} recently used MCP servers with read-only calls...`);
  const probes = [];
  for (const s of toProbe) {
    const p = await probeServer(hub, s.name);
    log(`  ${p.reachable ? pc.green("ok") : pc.yellow("unreachable")} ${s.name}${p.reachable ? ` (${p.tools.length} tools)` : ""}`);
    probes.push(p);
  }

  let senders: Evidence["senders"] = [];
  let recipients: Evidence["recipients"] = [];
  let meetings: Evidence["meetings"] = [];
  let auth: Awaited<ReturnType<typeof authorizedClient>> | null = null;
  try {
    auth = await authorizedClient();
  } catch (err) {
    log(pc.yellow(`Email and calendar skipped: ${err instanceof Error ? err.message : err}`));
  }
  if (auth) {
    const gmail = new GmailSource(auth);
    try {
      log("Reading who emails you and who you reply to, last 90 days (headers only)...");
      senders = (await gmail.senderStats(90)).filter((d) => !PERSONAL_DOMAINS.has(d.domain));
      recipients = await gmail.recipientStats(90);
      log(`  ${senders.length} sender domains, ${recipients.length} domains you write to`);
    } catch (err) {
      log(pc.yellow(`  skipped: ${err instanceof Error ? err.message : err}`));
    }
    try {
      log("Reading meetings with people outside your domain, last 90 days...");
      meetings = await meetingStats(auth, 90);
      log(`  ${meetings.length} domains you met with`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(pc.yellow(/insufficient|scope|403/i.test(msg) ? "  skipped: run `ibo setup gmail` again to allow Calendar (read-only)" : `  skipped: ${msg}`));
    }
  }

  return { evidence: { sessions, repos, probes, senders, recipients, meetings, assistants }, hub };
}

function toolRiskFor(ev: Evidence, server: string, tool: string): RiskLevel {
  const t = ev.probes.find((p) => p.server === server)?.tools.find((x) => x.name === tool);
  return suggestRisk(tool, t?.annotations ?? {});
}

async function reviewCandidate(c: Candidate, assumeYes: boolean): Promise<Project | null> {
  const p = c.project;
  console.log(`\n${pc.bold(p.name ?? p.id)}  ${pc.dim(`[${p.status}${p.lastActivity ? `, last activity ${p.lastActivity.slice(0, 10)}` : ""}]`)}`);
  for (const e of c.evidence) console.log(pc.dim(`  - ${e}`));
  const steps = Object.entries(p.playbook).map(([a, s]) =>
    s.kind === "mcp" ? `${a} -> ${s.server}/${s.tool}` : s.kind === "claude-code" ? `${a} -> Claude Code in ${s.repo}` : a,
  );
  if (steps.length) console.log(`  Actions: ${steps.join(", ")}`);
  if (p.match.domains.length || p.match.senders.length) {
    console.log(`  Email: ${[...p.match.senders, ...p.match.domains.map((d) => `@${d}`)].join(", ")}`);
  }

  if (assumeYes) {
    console.log(pc.dim("  Added as proposed (--yes)."));
    return p;
  }

  if (c.question) {
    const answer = await select({
      message: c.question.text,
      choices: c.question.options.map((o, i) => ({
        name: `${o.label}${i === 0 ? RECOMMENDED : ""}`,
        value: o.label,
        description: o.reason,
      })),
    });
    c.evidence.push(`User answered "${c.question.text}": ${answer}`);
  }

  const noEmail = p.match.domains.length === 0 && p.match.senders.length === 0;
  const asProposed = {
    name: `Add as proposed${noEmail ? "" : RECOMMENDED}`,
    value: "add",
    description: noEmail ? "No email address is linked yet, so mail will not route here." : "Uses the email matching and actions above.",
  };
  const withEmail = { name: `Add and set which emails belong to it${noEmail ? RECOMMENDED : ""}`, value: "edit" };
  // The recommended option is always listed first.
  const choice = await select({
    message: `Add ${p.name ?? p.id}?`,
    choices: [...(noEmail ? [withEmail, asProposed] : [asProposed, withEmail]), { name: "Skip", value: "skip" }],
  });
  if (choice === "skip") return null;
  if (choice === "edit") {
    const domains = await input({ message: "Domains (comma separated, e.g. coleven.com):", default: p.match.domains.join(", ") });
    const senders = await input({ message: "Specific senders (comma separated):", default: p.match.senders.join(", ") });
    p.match.domains = split(domains);
    p.match.senders = split(senders);
  }
  return p;
}

const split = (s: string) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/** A project discovery could not see: lives in a hosted builder, another machine, or only in email. */
async function askManualProject(ev: Evidence): Promise<Project> {
  const name = (await input({ message: "Project name:", validate: (v) => !!v.trim() || "Required" })).trim();
  const where = await select({
    message: `Where does ${name} live?`,
    choices: [
      { name: "A folder on this Mac", value: "folder" },
      { name: "An app reached through an MCP server (Base44, Linear, ...)", value: "mcp" },
      { name: "Only email for now (reminders)", value: "email" },
    ],
  });
  const playbook: Project["playbook"] = {};
  let folder: string | undefined;
  if (where === "folder") {
    folder = (await input({ message: "Folder path:" })).trim().replace(/^~/, process.env.HOME ?? "");
    const repo = await repoInfo(folder);
    if (repo.isGit) {
      playbook.reproduce_bug = { kind: "claude-code", repo: folder, baseBranch: repo.defaultBranch ?? "main" };
      playbook.prepare_fix = { kind: "claude-code", repo: folder, baseBranch: repo.defaultBranch ?? "main" };
    }
  } else if (where === "mcp") {
    // Local MCP configs, plus claude.ai connectors (Base44, ...) seen in Claude Code sessions.
    const seen = ev.sessions.servers.filter((s) => s.server.startsWith("claude_ai_"));
    const servers = [...new Set([...discoverMcpServers().map((s) => s.name), ...seen.map((s) => s.server)])];
    if (servers.length === 0) {
      console.log(pc.yellow("  No MCP servers found in Claude Code, Claude Desktop or your claude.ai connectors, so tasks will be reminders for now."));
    } else {
      const server = await select({ message: "Which MCP server?", choices: servers.map((s) => ({ name: s, value: s })) });
      const usage = ev.sessions.servers.find((s) => s.server === server)?.tools ?? {};
      const tools = ev.probes.find((p) => p.server === server)?.tools.map((t) => t.name) ?? Object.keys(usage).sort((a, b) => usage[b] - usage[a]);
      const tool = tools.length
        ? await select({ message: "Tool to use for new tasks:", choices: tools.map((t) => ({ name: t, value: t })) })
        : (await input({ message: "Tool name for new tasks:" })).trim();
      if (tool) playbook.create_task = { kind: "mcp", server, tool };
    }
  }
  playbook.create_reminder ??= { kind: "reminder" };
  const domains = await input({ message: "Email domains that belong to it (comma separated):" });
  const senders = await input({ message: "Specific senders (comma separated):" });
  return {
    id: slugify(name),
    name,
    status: "live",
    lastActivity: new Date().toISOString(),
    match: { senders: split(senders), domains: split(domains), keywords: [name.toLowerCase()] },
    summary: undefined,
    playbook,
    autonomy: {},
  };
}

/** Interactive onboarding: discover, propose, ask, write config. */
export async function onboard(models: ModelRouter | null, opts: { assumeYes?: boolean; imports?: string[] } = {}): Promise<void> {
  const assumeYes = !!opts.assumeYes;
  ensureHome();
  const log = (s: string) => console.log(s);
  const imports = [...(opts.imports ?? [])];
  if (imports.length === 0 && !assumeYes) {
    for (const file of findExports()) {
      const name = file.split("/").pop();
      if (await confirm({ message: `Found a Claude or ChatGPT export in Downloads (${name}). Use its project names and chat titles?`, default: true })) {
        imports.push(file);
      }
    }
  }
  const { evidence, hub } = await gatherEvidence(log, imports);

  let candidates: Candidate[];
  if (models) {
    log("\nAsking the model to connect the evidence into projects...");
    try {
      candidates = await proposeWithModel(models, evidence);
    } catch (err) {
      log(pc.yellow(`Model proposal failed (${err instanceof Error ? err.message : err}); using folder-based proposal.`));
      candidates = proposeDeterministic(evidence);
    }
  } else {
    candidates = proposeDeterministic(evidence);
  }

  const dead = candidates.filter((c) => c.project.status === "dead");
  const active = candidates
    .filter((c) => c.project.status !== "dead")
    .sort((a, b) => (a.project.status === b.project.status ? b.confidence - a.confidence : a.project.status === "live" ? -1 : 1));
  log(`\nFound ${active.length} live or dormant projects. ${dead.length} with no activity in 180 days were left out.`);

  const existing = loadProjects();
  const accepted: Project[] = [];
  for (const c of active) {
    const p = await reviewCandidate(c, assumeYes);
    if (!p) continue;
    if (c.summary) {
      const rel = join("projects", `${p.id}.md`);
      writeFileSync(join(paths.home, rel), `# ${p.name ?? p.id}\n\n${c.summary}\n`, { mode: 0o600 });
      p.summary = rel;
    }
    accepted.push(p);
  }

  if (dead.length > 0 && !assumeYes) {
    const revive = await checkbox({
      message: "Inactive projects (no activity in 180 days). Add any of them anyway?",
      choices: dead.map((c) => ({ name: `${c.project.name ?? c.project.id} (${c.project.lastActivity?.slice(0, 10) ?? "no date"})`, value: c.project.id })),
    });
    accepted.push(...dead.filter((c) => revive.includes(c.project.id)).map((c) => c.project));
  }

  if (!assumeYes) {
    while (await confirm({ message: "Is there a project I missed (for example a Base44 app or a client with no code on this Mac)?", default: false })) {
      accepted.push(await askManualProject(evidence));
    }
  }

  // Confirm risk levels for every MCP tool that a playbook uses.
  const tools = loadTools();
  const used = new Map<string, { server: string; tool: string }>();
  for (const p of accepted)
    for (const s of Object.values(p.playbook)) if (s.kind === "mcp") used.set(`${s.server}/${s.tool}`, { server: s.server, tool: s.tool });
  if (used.size > 0) log("\nConfirm how risky each tool is. Unconfirmed tools are always treated as dangerous.");
  for (const [key, { server, tool }] of used) {
    if (tools.tools[key] !== undefined) continue;
    const suggested = toolRiskFor(evidence, server, tool);
    if (assumeYes) {
      tools.tools[key] = suggested;
      log(`  ${key}: level ${suggested} (${RISK_LABELS[suggested]})`);
      continue;
    }
    const levels = ([0, 1, 2, 3] as RiskLevel[]).sort((a, b) => (a === suggested ? -1 : b === suggested ? 1 : a - b));
    tools.tools[key] = await select({
      message: `${key}`,
      choices: levels.map((l) => ({ name: `Level ${l}: ${RISK_LABELS[l]}${l === suggested ? RECOMMENDED : ""}`, value: l })),
    });
  }

  const merged = new Map(existing.projects.map((p) => [p.id, p]));
  for (const p of accepted) merged.set(p.id, p);
  saveProjects({ projects: [...merged.values()] });
  saveTools(tools);
  await hub.closeAll();

  log(`\n${pc.green("Saved")} ${accepted.length} projects to ${paths.projects}`);
  log(`Tool risk levels in ${paths.tools}`);
  log(`Next: ${pc.bold("ibo start")} (or ${pc.bold("ibo install-agent")} to run it in the background).`);
}
