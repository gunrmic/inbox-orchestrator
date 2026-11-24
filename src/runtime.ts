import { loadProjects, loadSettings, loadTools } from "./config/load.js";
import { ensureHome, paths } from "./config/paths.js";
import type { Project, RiskLevel, Settings } from "./config/schema.js";
import { discoverMcpServers } from "./discovery/mcp-configs.js";
import { DefaultExecutor } from "./executors/index.js";
import { McpHub } from "./executors/mcp-hub.js";
import { AnthropicProvider, OllamaProvider } from "./models/providers.js";
import { ModelRouter } from "./models/router.js";
import type { PipelineDeps } from "./pipeline/index.js";
import { Store } from "./store/db.js";
import { anthropicKey } from "./util/secrets.js";

export interface Runtime extends PipelineDeps {
  hub: McpHub;
  reload(): void;
  close(): Promise<void>;
}

export function buildModels(settings: Settings, store?: Store): ModelRouter {
  return new ModelRouter({
    settings: settings.models,
    allowLocalModels: settings.org.allowLocalModels && process.env.IBO_BLOCK_LOCAL_MODELS !== "1",
    providers: {
      anthropic: new AnthropicProvider(anthropicKey),
      ollama: new OllamaProvider(settings.models.ollamaUrl),
    },
    onFallback: (stage, from, to, reason) => store?.audit("model_fallback", { stage, from, to, reason }),
  });
}

/** Builds every long-lived dependency. Config files are re-read on reload(). */
export function buildRuntime(log: (s: string) => void = console.log): Runtime {
  ensureHome();
  const store = new Store(paths.db);
  let settings = loadSettings();
  let projects: Project[] = loadProjects().projects;
  let toolRisks: Record<string, RiskLevel> = loadTools().tools;
  const hub = new McpHub(discoverMcpServers());
  const models = buildModels(settings, store);

  return {
    store,
    hub,
    models,
    executor: new DefaultExecutor(hub),
    settings: () => settings,
    projects: () => projects,
    toolRisks: () => toolRisks,
    log,
    reload() {
      settings = loadSettings();
      projects = loadProjects().projects;
      toolRisks = loadTools().tools;
    },
    async close() {
      await hub.closeAll();
      store.close();
    },
  };
}
