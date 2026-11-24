import { execFile } from "node:child_process";
import { platform, totalmem } from "node:os";
import { promisify } from "node:util";
import { confirm, password, select } from "@inquirer/prompts";
import pc from "picocolors";
import type { Settings } from "./config/schema.js";
import { authorizeInteractive } from "./gmail/auth.js";
import { OllamaProvider } from "./models/providers.js";
import { hasClaude } from "./util/claude-cli.js";
import { suggestLocalModel } from "./util/local-model.js";
import { anthropicKey, getSecret, setSecret } from "./util/secrets.js";

const run = promisify(execFile);
const RECOMMENDED = pc.green(" (recommended)");

export async function has(cmd: string): Promise<boolean> {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export interface SetupIO {
  log: (s: string) => void;
  /** Re-ask even when a step is already done. */
  force?: boolean;
}

/** Planning model: the Claude Code login when there is one, an API key otherwise. */
export async function setupClaude(io: SetupIO): Promise<"claude-code" | "api" | "none"> {
  const key = await anthropicKey();
  if (key && !io.force) {
    io.log(pc.green("✓ Claude: API key in the Keychain"));
    return "api";
  }
  if ((await hasClaude()) && !io.force) {
    io.log(pc.green("✓ Claude: using your Claude Code login, no API key needed"));
    return "claude-code";
  }
  const choice = await select({
    message: "Claude plans the work. How should the agent reach it?",
    choices: [
      ...((await hasClaude()) ? [{ name: `Use my Claude Code login${RECOMMENDED}`, value: "cli", description: "Uses your Pro or Max plan." }] : []),
      { name: `Paste an Anthropic API key${(await hasClaude()) ? "" : RECOMMENDED}`, value: "key", description: "Stored in the macOS Keychain." },
      { name: "Skip for now", value: "skip", description: "Only the local model will run; planning waits." },
    ],
  });
  if (choice === "cli") return "claude-code";
  if (choice === "key") {
    const k = await password({ message: "Anthropic API key:", mask: "*" });
    if (k.trim()) {
      await setSecret("anthropic-api-key", k.trim());
      return "api";
    }
  }
  return "none";
}

export async function setupGmail(io: SetupIO): Promise<void> {
  if ((await getSecret("google-refresh-token")) && !io.force) {
    io.log(pc.green("✓ Gmail connected"));
    return;
  }
  io.log("\nA browser window will open. Sign in with Google and allow read-only access to Gmail and Calendar.");
  await authorizeInteractive();
  io.log(pc.green("✓ Gmail connected (read-only)"));
}

/** Local model: installs Ollama with Homebrew if the user agrees, starts it, pulls a model sized to this Mac. */
export async function setupLocalModel(settings: Settings, io: SetupIO, ollama = new OllamaProvider(settings.models.ollamaUrl)): Promise<void> {
  if (!settings.org.allowLocalModels && !io.force) {
    io.log(pc.dim("• Local models are off (organization policy). Using the paid model."));
    return;
  }
  const model = suggestLocalModel();
  let up = await ollama.available();

  if (!up && !(await has("ollama"))) {
    if (platform() === "darwin" && (await has("brew"))) {
      const ok = await confirm({
        message: `Install Ollama to triage email locally for free (${Math.round(totalmem() / 1024 ** 3)}GB memory, model ${model})?`,
        default: true,
      });
      if (ok) {
        io.log("Installing Ollama with Homebrew...");
        await run("brew", ["install", "ollama"], { timeout: 20 * 60_000 });
        await run("brew", ["services", "start", "ollama"]).catch(() => undefined);
      }
    } else {
      io.log(pc.yellow(`• Ollama is not installed. Get it from https://ollama.com, then re-run ibo setup. Using the paid model until then.`));
    }
  } else if (!up && (await has("brew"))) {
    await run("brew", ["services", "start", "ollama"]).catch(() => undefined);
  }

  for (let i = 0; i < 10 && !up; i++) {
    up = await ollama.available();
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) {
    io.log(pc.yellow("• Ollama is not running. Email triage uses the paid model until it is."));
    return;
  }

  settings.models.filter = { provider: "ollama", model };
  settings.models.route = { provider: "ollama", model };
  settings.org.allowLocalModels = true;
  if (!(await ollama.hasModel(model))) {
    io.log(`Downloading ${model} (a few GB, one time)...`);
    await ollama.pull(model);
  }
  io.log(pc.green(`✓ Local model ${model}`));
}
