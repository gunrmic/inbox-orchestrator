import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { loadProjects, loadSettings, loadTools, saveSettings } from "../config/load.js";
import { Project, type RiskLevel } from "../config/schema.js";
import { findExports } from "../discovery/exports.js";
import { gatherEvidence, proposeCandidates, saveAccepted, suggestedToolLevels, writeSummary } from "../discovery/onboard.js";
import type { Candidate, Evidence } from "../discovery/propose.js";
import { slugify } from "../executors/claude-code.js";
import { authorizeInteractive } from "../gmail/auth.js";
import { AnthropicProvider, OllamaProvider } from "../models/providers.js";
import type { Runtime } from "../runtime.js";
import { buildModels } from "../runtime.js";
import { has } from "../setup.js";
import { hasClaude } from "../util/claude-cli.js";
import { suggestLocalModel } from "../util/local-model.js";
import { anthropicKey, getSecret, setSecret } from "../util/secrets.js";

const run = promisify(execFile);

type JobState = "idle" | "running" | "done" | "error";
interface Job {
  state: JobState;
  error?: string;
}

/** What the setup window shows for one found project. */
export interface CandidateView {
  id: string;
  name: string;
  status: string;
  lastActivity?: string;
  evidence: string[];
  domains: string[];
  senders: string[];
  actions: string[];
  /** The option the window pre-selects: add when there is a strong link, skip for weak guesses. */
  recommended: "add" | "skip";
  question?: Candidate["question"];
}

function view(c: Candidate): CandidateView {
  const p = c.project;
  const actions = Object.entries(p.playbook).map(([a, s]) =>
    s.kind === "mcp" ? `${a} via ${s.server}/${s.tool}` : s.kind === "claude-code" ? `${a} with Claude Code in ${s.repo}` : `${a} as a reminder`,
  );
  return {
    id: p.id,
    name: p.name ?? p.id,
    status: p.status,
    lastActivity: p.lastActivity,
    evidence: c.evidence,
    domains: p.match.domains,
    senders: p.match.senders,
    actions,
    recommended: c.confidence >= 0.5 || p.status === "live" ? "add" : "skip",
    question: c.question,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Everything `ibo setup` does, as local API calls for the app's setup window. Long steps
 * run as background jobs; the window polls GET /setup/status and shows their progress.
 */
export function registerSetupApi(app: FastifyInstance, rt: Runtime): void {
  const google: Job & { url?: string } = { state: "idle" };
  const model: Job & { step?: string; progress?: number } = { state: "idle" };
  const discover: Job & { log: string[]; candidates: Candidate[]; dead: Candidate[]; evidence?: Evidence } = {
    state: "idle",
    log: [],
    candidates: [],
    dead: [],
  };

  const ollama = () => new OllamaProvider(rt.settings().models.ollamaUrl);
  const localAllowed = () => rt.settings().org.allowLocalModels && process.env.IBO_BLOCK_LOCAL_MODELS !== "1";

  app.get("/setup/status", async () => {
    const o = ollama();
    const running = localAllowed() ? await o.available() : false;
    const name = suggestLocalModel();
    return {
      done: rt.store.get("setup:done") !== null,
      google: { connected: !!(await getSecret("google-refresh-token")), ...google },
      claude: { route: await new AnthropicProvider(anthropicKey).route(), installed: await hasClaude() },
      model: {
        allowed: localAllowed(),
        running,
        installed: running || (await has("ollama")),
        brew: await has("brew"),
        name,
        ready: running ? await o.hasModel(name).catch(() => false) : false,
        ...model,
      },
      discover: { state: discover.state, error: discover.error, log: discover.log.slice(-8), found: discover.candidates.length },
      projects: rt.projects().length,
    };
  });

  /** Starts the Google sign-in; the browser opens on the Mac. Answers with the URL as a fallback link. */
  app.post("/setup/google", async () => {
    if (google.state !== "running") {
      google.state = "running";
      google.error = undefined;
      let resolveUrl: (u: string) => void = () => undefined;
      const urlReady = new Promise<string>((r) => (resolveUrl = r));
      authorizeInteractive({
        onUrl: (u) => {
          google.url = u;
          resolveUrl(u);
        },
      })
        .then(() => {
          google.state = "done";
        })
        .catch((err) => {
          google.state = "error";
          google.error = message(err);
          resolveUrl("");
        });
      await Promise.race([urlReady, new Promise((r) => setTimeout(r, 5000))]);
    }
    return { state: google.state, url: google.url, error: google.error };
  });

  app.post<{ Body: { key?: string } }>("/setup/claude-key", async (req) => {
    const key = req.body?.key?.trim();
    if (!key) return { error: "Paste an API key." };
    await setSecret("anthropic-api-key", key);
    return { ok: true };
  });

  /** Installs Ollama with Homebrew if needed, starts it, downloads the model sized to this Mac. */
  app.post("/setup/model", async () => {
    if (model.state === "running") return { state: model.state };
    if (!localAllowed()) return { error: "Local models are off by organization policy." };
    Object.assign(model, { state: "running", error: undefined, step: "Checking Ollama", progress: 0 });
    void (async () => {
      const o = ollama();
      const name = suggestLocalModel();
      if (!(await o.available())) {
        if (!(await has("ollama"))) {
          if (platform() !== "darwin" || !(await has("brew"))) throw new Error("Install Ollama from https://ollama.com, then try again.");
          model.step = "Installing Ollama";
          await run("brew", ["install", "ollama"], { timeout: 20 * 60_000 });
        }
        model.step = "Starting Ollama";
        await run("brew", ["services", "start", "ollama"]).catch(() => run("ollama", ["serve"]).catch(() => undefined));
        for (let i = 0; i < 20 && !(await o.available()); i++) await new Promise((r) => setTimeout(r, 1000));
        if (!(await o.available())) throw new Error("Ollama did not start.");
      }
      if (!(await o.hasModel(name))) {
        model.step = `Downloading ${name}`;
        await o.pull(name, (f) => (model.progress = f));
      }
      const s = loadSettings();
      s.models.filter = { provider: "ollama", model: name };
      s.models.route = { provider: "ollama", model: name };
      s.org.allowLocalModels = true;
      saveSettings(s);
      rt.reload();
      Object.assign(model, { state: "done", step: `Ready: ${name}`, progress: 1 });
    })().catch((err) => Object.assign(model, { state: "error", error: message(err) }));
    return { state: model.state };
  });

  /** Claude and ChatGPT exports in ~/Downloads. Only on request, since macOS may ask for access. */
  app.get("/setup/exports", async () => findExports().map((path) => ({ path, name: path.split("/").pop() })));

  app.post<{ Body: { imports?: string[] } }>("/setup/discover", async (req) => {
    if (discover.state === "running") return { state: discover.state };
    Object.assign(discover, { state: "running", error: undefined, log: [], candidates: [], dead: [] });
    void (async () => {
      const log = (s: string) => void discover.log.push(s.replace(/\x1b\[[0-9;]*m/g, ""));
      const { evidence, hub } = await gatherEvidence(log, req.body?.imports ?? []);
      try {
        const models = (await new AnthropicProvider(anthropicKey).available()) ? buildModels(rt.settings(), rt.store) : null;
        const { active, dead } = await proposeCandidates(models, evidence, log);
        Object.assign(discover, { candidates: active, dead, evidence, state: "done" });
        log(`Found ${active.length} projects.`);
      } finally {
        await hub.closeAll();
      }
    })().catch((err) => Object.assign(discover, { state: "error", error: message(err) }));
    return { state: discover.state };
  });

  app.get("/setup/candidates", async () => ({
    active: discover.candidates.map(view),
    inactive: discover.dead.map(view),
  }));

  /**
   * Saves what the user picked. Each pick can change the email domains and senders.
   * Projects the user adds by hand start with reminders only.
   */
  app.post<{
    Body: { picks?: { id: string; domains?: string[]; senders?: string[] }[]; manual?: { name: string; domains?: string[]; senders?: string[] }[] };
  }>("/setup/projects", async (req) => {
    const clean = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    const all = [...discover.candidates, ...discover.dead];
    const accepted: Project[] = [];
    for (const pick of req.body?.picks ?? []) {
      const c = all.find((x) => x.project.id === pick.id);
      if (!c) return { error: `Unknown project ${pick.id}` };
      const p = Project.parse({ ...c.project, match: { ...c.project.match, domains: clean(pick.domains ?? c.project.match.domains), senders: clean(pick.senders ?? c.project.match.senders) } });
      writeSummary(p, c.summary);
      accepted.push(p);
    }
    for (const m of req.body?.manual ?? []) {
      if (!m.name?.trim()) continue;
      accepted.push(
        Project.parse({
          id: slugify(m.name) || "project",
          name: m.name.trim(),
          status: "live",
          lastActivity: new Date().toISOString(),
          match: { domains: clean(m.domains), senders: clean(m.senders), keywords: [m.name.trim().toLowerCase()] },
          playbook: { create_reminder: { kind: "reminder" } },
        }),
      );
    }
    const tools = loadTools();
    const levels: Record<string, RiskLevel> = discover.evidence ? suggestedToolLevels(accepted, discover.evidence) : {};
    for (const [k, v] of Object.entries(levels)) if (tools.tools[k] === undefined) tools.tools[k] = v;
    saveAccepted(accepted, tools);
    rt.reload();
    rt.store.audit("setup_projects", { saved: accepted.map((p) => p.id) });
    return { saved: accepted.length, projects: loadProjects().projects.length };
  });

  app.post("/setup/finish", async () => {
    rt.store.set("setup:done", new Date().toISOString());
    rt.store.audit("setup_done", {});
    return { ok: true };
  });
}
