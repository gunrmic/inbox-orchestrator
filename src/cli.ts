#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { totalmem, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { confirm, input, password, select } from "@inquirer/prompts";
import pc from "picocolors";
import { loadProjects, loadSettings, saveSettings } from "./config/load.js";
import { ensureHome, paths } from "./config/paths.js";
import { onboard } from "./discovery/onboard.js";
import { authorizeInteractive, saveClientCredentials } from "./gmail/auth.js";
import { OllamaProvider } from "./models/providers.js";
import { buildModels, buildRuntime } from "./runtime.js";
import { processEmail } from "./pipeline/index.js";
import { apiToken } from "./server/api.js";
import { anthropicKey, getSecret, setSecret } from "./util/secrets.js";
import { installAgent, uninstallAgent } from "./util/launchd.js";
import type { Email } from "./types.js";

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const RECOMMENDED = pc.green(" (recommended)");

/** Suggest a local model size from installed memory. Models are configurable in settings.yaml. */
export function suggestLocalModel(bytes = totalmem()): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 48) return "qwen3:30b";
  if (gb >= 24) return "qwen3:14b";
  if (gb >= 16) return "qwen3:8b";
  return "qwen3:4b";
}

async function has(cmd: string): Promise<boolean> {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const port = loadSettings().server.port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error("The daemon is not running. Start it with `ibo start` or `ibo install-agent`.");
  });
  return res.json();
}

const program = new Command();
program.name("ibo").description("inbox-orchestrator: turns incoming email into prepared work on your Mac.").version(pkg.version);

program
  .command("setup")
  .description("Connect Anthropic, Gmail and a local model. Safe to re-run.")
  .argument("[part]", "anthropic | gmail | models (default: all)")
  .action(async (part?: string) => {
    ensureHome();
    const settings = loadSettings();

    if (!part || part === "anthropic") {
      const existing = await anthropicKey();
      if (!existing || (await confirm({ message: "Replace the stored Anthropic API key?", default: false }))) {
        const key = await password({ message: "Anthropic API key (stored in the macOS Keychain):", mask: "*" });
        if (key) await setSecret("anthropic-api-key", key.trim());
      }
    }

    if (!part || part === "gmail") {
      console.log(
        `\nGmail uses your own Google Cloud OAuth client (Desktop app), read-only scope.\nSee README > "Connect Gmail" for the 3-minute setup.`,
      );
      if (!(await getSecret("google-oauth-client")) || (await confirm({ message: "Replace the OAuth client?", default: false }))) {
        const file = await input({ message: "Path to the downloaded client JSON:" });
        await saveClientCredentials(readFileSync(file.trim().replace(/^~/, process.env.HOME ?? ""), "utf8"));
      }
      await authorizeInteractive();
      console.log(pc.green("Gmail connected (read-only)."));
    }

    if (!part || part === "models") {
      const ollama = new OllamaProvider(settings.models.ollamaUrl);
      const up = await ollama.available();
      const suggested = suggestLocalModel();
      const choice = await select({
        message: up
          ? `Ollama is running. Which model should triage email locally? (${Math.round(totalmem() / 1024 ** 3)}GB memory)`
          : "Ollama is not running. How should email triage run?",
        choices: [
          ...(up
            ? [{ name: `Local ${suggested}${RECOMMENDED}`, value: "local", description: "Free, and email stays on this Mac. Falls back to the paid model on failure." }]
            : [{ name: `Install Ollama later, use the paid model until then${RECOMMENDED}`, value: "local", description: `Then run: ollama pull ${suggested}` }]),
          { name: "Always use the paid model", value: "paid", description: "For organizations that block local models." },
        ],
      });
      if (choice === "local") {
        settings.models.filter = { provider: "ollama", model: suggested };
        settings.models.route = { provider: "ollama", model: suggested };
        settings.org.allowLocalModels = true;
        if (up) console.log(pc.dim(`If the model is missing: ollama pull ${suggested}`));
      } else {
        settings.org.allowLocalModels = false;
      }
    }

    saveSettings(settings);
    console.log(`\n${pc.green("Settings saved")} to ${paths.settings}. Next: ${pc.bold("ibo onboard")}`);
  });

program
  .command("onboard")
  .description("Discover your projects and tools, answer a few questions, write the config.")
  .option("--no-model", "Propose projects from folders only, without calling a model")
  .action(async (opts: { model: boolean }) => {
    const models = opts.model && (await anthropicKey()) ? buildModels(loadSettings()) : null;
    await onboard(models);
  });

program
  .command("start")
  .description("Run the daemon in the foreground (API + Gmail watcher).")
  .action(async () => {
    const { startDaemon } = await import("./daemon.js");
    await startDaemon();
  });

program
  .command("install-agent")
  .description("Run the daemon in the background at login (macOS launchd).")
  .action(async () => {
    const file = await installAgent(fileURLToPath(import.meta.url));
    console.log(`${pc.green("Installed")} ${file}\nLogs: ${paths.logs}`);
  });

program
  .command("uninstall-agent")
  .description("Stop and remove the background agent.")
  .action(async () => {
    await uninstallAgent();
    console.log("Removed.");
  });

program
  .command("status")
  .description("Show daemon status and pending cards.")
  .action(async () => {
    const s = await api("/status");
    console.log(`Mode: ${s.mode}${s.killSwitch ? pc.red("  KILL SWITCH ON") : ""}`);
    console.log(`Pending: ${s.pending}   Last poll: ${s.lastPoll ?? "never"}`);
    for (const p of s.projects) console.log(`  ${p.status === "live" ? pc.green("●") : pc.dim("○")} ${p.name} (${p.status})`);
  });

program
  .command("pending")
  .description("List actions waiting for approval.")
  .action(async () => {
    const list = await api("/actions?status=pending");
    if (list.length === 0) return console.log("Nothing waiting.");
    for (const a of list) {
      console.log(`${pc.bold(`#${a.id}`)} L${a.risk} ${a.projectId ?? "unmapped"}/${a.action}: ${a.summary}`);
      console.log(pc.dim(`     ${a.email?.from ?? ""} | ${a.email?.subject ?? ""} | ${a.reason}`));
    }
  });

program
  .command("approve")
  .argument("<id>")
  .description("Approve and run a pending action.")
  .action(async (id: string) => {
    const r = await api(`/actions/${id}/approve`, "POST");
    console.log(r.error ?? `${r.action.status}: ${r.action.result ?? ""}`);
    if (r.offerPromotion) console.log(pc.yellow(`You approved this ${10}+ times in a row. Make it automatic: ibo promote ${r.action.projectId} ${r.action.action}`));
  });

program
  .command("reject")
  .argument("<id>")
  .description("Reject a pending action.")
  .action(async (id: string) => console.log((await api(`/actions/${id}/reject`, "POST")).ok ? "Rejected." : "Not found."));

program
  .command("promote")
  .argument("<project>")
  .argument("<action>")
  .description("Make a level-2 action automatic for one project.")
  .action(async (project: string, action: string) => console.log(await api("/promote", "POST", { projectId: project, action })));

program
  .command("kill")
  .argument("[state]", "on | off", "on")
  .description("Kill switch: on = nothing executes, everything waits for approval.")
  .action(async (state: string) => {
    const r = await api("/killswitch", "POST", { on: state !== "off" });
    console.log(`Kill switch ${r.killSwitch ? pc.red("ON") : pc.green("off")}`);
  });

program
  .command("simulate")
  .description("Run one fake email through the pipeline (no Gmail needed). Executes only what policy allows.")
  .requiredOption("--from <address>", "Sender, e.g. 'Jack <jack@coleven.com>'")
  .requiredOption("--subject <text>")
  .requiredOption("--body <text>")
  .option("--dry", "Plan and decide, but never execute")
  .action(async (o: { from: string; subject: string; body: string; dry?: boolean }) => {
    const rt = buildRuntime();
    if (o.dry) {
      rt.executor = { run: async ({ record }) => `[dry run] would execute ${record.action}` };
    }
    const m = o.from.match(/<([^>]+)>/);
    const email: Email = {
      id: `sim-${Date.now()}`,
      threadId: "sim",
      from: o.from,
      fromAddress: (m ? m[1] : o.from).toLowerCase(),
      to: [],
      cc: [],
      subject: o.subject,
      date: new Date().toISOString(),
      snippet: o.body.slice(0, 100),
      body: o.body,
      attachments: [],
      auth: { spf: "pass", dkim: "pass" },
    };
    const out = await processEmail(rt, email);
    if (out.skipped) console.log(`Skipped: ${out.skipped}`);
    for (const a of out.actions) {
      console.log(`${pc.bold(a.decision.padEnd(7))} L${a.risk} ${a.action}: ${a.summary}`);
      console.log(pc.dim(`        ${a.reason}${a.result ? `\n        ${a.result.split("\n")[0]}` : ""}`));
    }
    await rt.close();
  });

program
  .command("doctor")
  .description("Check that everything the agent needs is in place.")
  .action(async () => {
    const s = loadSettings();
    const check = (ok: boolean, label: string, hint = "") => console.log(`${ok ? pc.green("✓") : pc.red("✗")} ${label}${!ok && hint ? pc.dim(`  ${hint}`) : ""}`);
    check(platform() === "darwin", "macOS", "Runs on Linux for development, but Reminders and launchd need macOS.");
    check(!!(await anthropicKey()), "Anthropic API key", "ibo setup anthropic");
    check(!!(await getSecret("google-refresh-token")), "Gmail connected", "ibo setup gmail");
    check(await has("claude"), "Claude Code on PATH", "npm i -g @anthropic-ai/claude-code");
    check(await has("git"), "git on PATH");
    const local = await new OllamaProvider(s.models.ollamaUrl).available();
    check(local || !s.org.allowLocalModels, "Local model server", "brew install ollama && ollama serve (or set org.allowLocalModels: false)");
    check(existsSync(paths.projects) && loadProjects().projects.length > 0, "Projects mapped", "ibo onboard");
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
