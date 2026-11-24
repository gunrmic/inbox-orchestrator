#!/usr/bin/env node
import "./util/quiet.js";
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
import { AnthropicProvider, describeModel, OllamaProvider } from "./models/providers.js";
import { setupClaude, setupGmail, setupLocalModel } from "./setup.js";
import { canSelfUpdate, selfUpdate } from "./util/update.js";
import { hasClaude } from "./util/claude-cli.js";
import { buildModels, buildRuntime } from "./runtime.js";
import { processEmail } from "./pipeline/index.js";
import { apiToken } from "./server/api.js";
import { anthropicKey, getSecret, setSecret } from "./util/secrets.js";
import { installAgent, uninstallAgent } from "./util/launchd.js";
import { suggestLocalModel } from "./util/local-model.js";
import type { Email } from "./types.js";

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const RECOMMENDED = pc.green(" (recommended)");

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
  .description("Everything in one go: Claude, Gmail, local model, project discovery, background agent. Safe to re-run.")
  .argument("[part]", "claude | gmail | models | onboard | agent (default: all)")
  .option("--key-stdin", "claude: read an Anthropic API key from stdin (no prompt, not in shell history)")
  .option("--client-json <path>", "gmail: use your own Google OAuth client JSON")
  .option("--local [model]", "models: triage with a local Ollama model (default: suggested by memory)")
  .option("--paid", "models: always use the paid model (for orgs that block local models)")
  .action(async (part: string | undefined, opts: { keyStdin?: boolean; clientJson?: string; local?: string | boolean; paid?: boolean }) => {
    ensureHome();
    const settings = loadSettings();
    const log = (s: string) => console.log(s);
    if (part === "anthropic") part = "claude";
    const io = { log, force: !!part };
    // Any flag means scripted mode: do only what the flags say, never prompt.
    const scripted = !!(opts.keyStdin || opts.clientJson || opts.local || opts.paid);
    const ask = (name: string) => !scripted && (!part || part === name);

    if (opts.keyStdin) {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const key = Buffer.concat(chunks).toString("utf8").trim();
      if (!key) throw new Error("No key on stdin.");
      await setSecret("anthropic-api-key", key);
      console.log(pc.green("Anthropic API key saved."));
    } else if (ask("claude")) {
      await setupClaude(io);
    }

    if (opts.clientJson) {
      await saveClientCredentials(readFileSync(opts.clientJson.replace(/^~/, process.env.HOME ?? ""), "utf8"));
      console.log(pc.green("Google OAuth client saved."));
      if (part === "gmail") await authorizeInteractive();
    } else if (ask("gmail")) {
      await setupGmail(io);
    }

    if (opts.local || opts.paid) {
      if (opts.paid) {
        settings.org.allowLocalModels = false;
      } else {
        const model = typeof opts.local === "string" ? opts.local : suggestLocalModel();
        settings.models.filter = { provider: "ollama", model };
        settings.models.route = { provider: "ollama", model };
        settings.org.allowLocalModels = true;
      }
      console.log(pc.green(`Triage model: ${opts.paid ? describeModel(settings.models.fallback) : `ollama:${settings.models.filter.model}`}`));
    } else if (ask("models")) {
      await setupLocalModel(settings, io);
    }
    saveSettings(settings);

    if (ask("onboard")) {
      const hasProjects = existsSync(paths.projects) && loadProjects().projects.length > 0;
      if (!hasProjects || part === "onboard" || (await confirm({ message: "Projects are already mapped. Run discovery again?", default: false }))) {
        console.log(pc.bold("\nDiscovering your projects"));
        const models = (await new AnthropicProvider(anthropicKey).available()) ? buildModels(loadSettings()) : null;
        await onboard(models);
      }
    }

    if (ask("agent") && platform() === "darwin") {
      if (part === "agent" || (await confirm({ message: "Run the agent in the background now and at every login?", default: true }))) {
        const file = await installAgent(fileURLToPath(import.meta.url));
        console.log(pc.green(`✓ Running in the background (${file})`));
      }
    }

    console.log(`\n${pc.green("Done.")} ${pc.dim(`Settings in ${paths.settings}. Check anytime with`)} ${pc.bold("ibo doctor")}`);
  });

program
  .command("onboard")
  .description("Discover your projects and tools, answer a few questions, write the config.")
  .option("--no-model", "Propose projects from folders only, without calling a model")
  .option("-y, --yes", "Accept every recommendation without asking (for scripts)")
  .option("--import <files...>", "Claude or ChatGPT data export (.zip, folder or conversations.json) to learn project names from")
  .action(async (opts: { model: boolean; yes?: boolean; import?: string[] }) => {
    const models = opts.model && (await new AnthropicProvider(anthropicKey).available()) ? buildModels(loadSettings()) : null;
    await onboard(models, { assumeYes: !!opts.yes, imports: opts.import ?? [] });
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
  .command("assign")
  .description("Answer \"which project is this sender?\" for a pending card, then re-plan the email.")
  .argument("<id>", "card id from `ibo pending`")
  .argument("<project>", "project id, or \"new\"")
  .option("--name <name>", "name for a new project")
  .option("--sender", "match only this sender, not the whole domain")
  .action(async (id: string, project: string, o: { name?: string; sender?: boolean }) => {
    const res = await api(`/actions/${id}/assign`, "POST", { project, name: o.name, ...(o.sender ? { scope: "sender" } : {}) });
    if (res.error) throw new Error(res.error);
    console.log(`${pc.green("Assigned to")} ${res.projectId}. ${res.actions.length} new card(s).`);
  });

program
  .command("update")
  .description("Update to the latest version now (the background agent also checks daily).")
  .action(async () => {
    if (!canSelfUpdate()) throw new Error("This copy was not installed with the installer. Use git pull, or re-run the install command.");
    const res = await selfUpdate();
    if (res.error) throw new Error(`Update failed, kept ${res.from?.slice(0, 7)}: ${res.error}`);
    console.log(res.updated ? pc.green(`Updated ${res.from?.slice(0, 7)} -> ${res.to?.slice(0, 7)}.`) : "Already up to date.");
    if (res.updated && platform() === "darwin") await installAgent(fileURLToPath(import.meta.url)).catch(() => undefined);
  });

program
  .command("suggestions")
  .description("Projects the weekly discovery found, or that went quiet. Accept or dismiss them.")
  .option("--accept <id>", "accept a suggestion")
  .option("--dismiss <id>", "dismiss a suggestion")
  .action(async (o: { accept?: string; dismiss?: string }) => {
    if (o.accept || o.dismiss) {
      const id = (o.accept ?? o.dismiss)!;
      const res = await api(`/suggestions/${encodeURIComponent(id)}`, "POST", { accept: !!o.accept });
      if (res.error) throw new Error(res.error);
      console.log(pc.green(o.accept ? "Accepted." : "Dismissed."));
      return;
    }
    const list = await api("/suggestions");
    if (!list.length) console.log("No suggestions.");
    for (const s of list) console.log(`${pc.bold(s.id)}  ${s.text}\n${s.evidence.map((e: string) => pc.dim(`    ${e}`)).join("\n")}`);
  });

program
  .command("doctor")
  .description("Check that everything the agent needs is in place.")
  .action(async () => {
    const s = loadSettings();
    const check = (ok: boolean, label: string, hint = "") => console.log(`${ok ? pc.green("✓") : pc.red("✗")} ${label}${!ok && hint ? pc.dim(`  ${hint}`) : ""}`);
    check(platform() === "darwin", "macOS", "Runs on Linux for development, but Reminders and launchd need macOS.");
    const route = await new AnthropicProvider(anthropicKey).route();
    check(
      route !== null,
      route === "api" ? "Claude via API key" : route === "claude-code" ? "Claude via your Claude Code login" : "Claude",
      "install Claude Code (uses your Claude plan), or ibo setup claude for an API key",
    );
    check(!!(await getSecret("google-refresh-token")), "Gmail connected", "ibo setup gmail");
    check(await hasClaude(), "Claude Code installed", "npm i -g @anthropic-ai/claude-code");
    check(await has("git"), "git on PATH");
    const local = await new OllamaProvider(s.models.ollamaUrl).available();
    check(local || !s.org.allowLocalModels, "Local model server", "brew install ollama && ollama serve (or set org.allowLocalModels: false)");
    check(existsSync(paths.projects) && loadProjects().projects.length > 0, "Projects mapped", "ibo onboard");
  });

// Explicit "node" argv: inside the .dmg this runs on Electron, where commander would otherwise skip the script path wrongly.
program.parseAsync(process.argv, { from: "node" }).catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
