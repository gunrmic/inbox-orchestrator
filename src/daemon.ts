import pc from "picocolors";
import { authorizedClient } from "./gmail/auth.js";
import { GmailSource } from "./gmail/client.js";
import { FixtureSource, type EmailSource } from "./gmail/source.js";
import { processEmail } from "./pipeline/index.js";
import { buildRuntime, type Runtime } from "./runtime.js";
import { buildApi } from "./server/api.js";
import { rediscover, rediscoverDue } from "./discovery/rediscover.js";
import { LABEL } from "./util/launchd.js";
import { notify } from "./util/notify.js";
import { canSelfUpdate, selfUpdate } from "./util/update.js";

const ts = () => new Date().toISOString().slice(11, 19);

/** The menu bar app pings /status every few seconds; if it is quiet, the daemon notifies by itself. */
export function menubarRunning(rt: Runtime, now = Date.now()): boolean {
  const seen = rt.store.get("menubar:lastSeen");
  return !!seen && now - Date.parse(seen) < 2 * 60_000;
}

/** One polling cycle: reload config, fetch new mail, run each email through the pipeline. */
export async function pollOnce(rt: Runtime, source: EmailSource): Promise<number> {
  rt.reload();
  const log = rt.log ?? (() => {});
  const emails = await source.poll(rt.store, rt.settings().gmail.query);
  rt.store.set("gmail:lastPoll", new Date().toISOString());
  for (const email of emails) {
    try {
      const out = await processEmail(rt, email);
      const waiting = out.actions.filter((a) => a.status === "pending");
      if (waiting.length && rt.settings().maintenance.notify && !menubarRunning(rt)) {
        notify(out.projectId ?? "Inbox Orchestrator", waiting.map((a) => a.summary).join("\n"));
      }
    } catch (err) {
      log(pc.red(`error on "${email.subject}": ${err instanceof Error ? err.message : err}`));
      rt.store.audit("error", { emailId: email.id, error: String(err) });
    }
  }
  return emails.length;
}

export async function emailSource(): Promise<EmailSource> {
  if (process.env.IBO_TEST_INBOX) return new FixtureSource(process.env.IBO_TEST_INBOX);
  return new GmailSource(await authorizedClient());
}

/**
 * Background chores between polls: weekly rediscovery (results wait in the menu bar) and a
 * daily update check. After an update the process exits so launchd starts the new version.
 */
export async function maintenance(rt: Runtime, log: (s: string) => void, now = Date.now()): Promise<void> {
  const m = rt.settings().maintenance;
  if (!process.env.IBO_TEST_INBOX && rediscoverDue(rt.store, m.rediscoverDays, now)) {
    log("Weekly discovery: looking for new or inactive projects...");
    const found = await rediscover(rt.store);
    if (found.length) {
      log(`${found.length} suggestion(s) waiting in the menu bar.`);
      if (m.notify && !menubarRunning(rt, now)) notify("Inbox Orchestrator", found.map((s) => s.text).join("\n"));
    }
  }

  const last = rt.store.get("update:last");
  if (m.autoUpdate && canSelfUpdate() && (!last || now - Date.parse(last) > 86_400_000)) {
    rt.store.set("update:last", new Date(now).toISOString());
    const res = await selfUpdate();
    rt.store.audit("update", res);
    if (res.updated) {
      log(`Updated ${res.from?.slice(0, 7)} -> ${res.to?.slice(0, 7)}.`);
      if (process.env.XPC_SERVICE_NAME === LABEL) {
        log("Restarting with the new version.");
        await rt.close();
        process.exit(0);
      }
      log("Restart the daemon to use it.");
    } else if (res.error) {
      log(pc.yellow(`Update skipped: ${res.error}`));
    }
  }
}

/** Foreground daemon: local API for the menu bar + polling loop. */
export async function startDaemon(): Promise<void> {
  const log = (s: string) => console.log(`${pc.dim(ts())} ${s}`);
  const rt = buildRuntime(log);
  const api = buildApi(rt);
  const port = rt.settings().server.port;
  await api.listen({ host: "127.0.0.1", port });
  log(`API on http://127.0.0.1:${port} (token in ~/.inbox-orchestrator/api-token)`);

  // Before setup there is no Gmail yet: the API still runs (the setup window needs it)
  // and polling starts as soon as the sign-in is done.
  let source: EmailSource | null = null;
  let waitingLogged = false;
  const connect = async () => {
    if (source) return source;
    try {
      source = await emailSource();
      rt.store.set("daemon:state", "watching");
      rt.store.set("daemon:message", `Watching ${process.env.IBO_TEST_INBOX ? "test inbox" : "Gmail"}`);
      rt.store.audit("daemon", { message: `Started. Watching ${process.env.IBO_TEST_INBOX ? "a test inbox" : "Gmail"} for ${rt.projects().length} projects` });
      log(
        `Watching ${process.env.IBO_TEST_INBOX ? "test inbox" : "Gmail"}. ${rt.projects().length} projects mapped. Mode: ${rt.settings().mode}${rt.settings().killSwitch ? pc.red(" KILL SWITCH ON") : ""}`,
      );
    } catch (err) {
      rt.store.set("daemon:state", "waiting-setup");
      rt.store.set("daemon:message", err instanceof Error ? err.message : String(err));
      if (!waitingLogged) log(`Waiting for setup: ${err instanceof Error ? err.message : err}`);
      waitingLogged = true;
    }
    return source;
  };

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping...");
    rt.store.set("daemon:state", "stopped");
    await api.close();
    await rt.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Config edits (projects.yaml, tools.yaml, settings.yaml) apply without a restart.
  process.on("SIGHUP", () => {
    rt.reload();
    log("Config reloaded.");
  });

  // Onboarding just ran discovery, so the first background run waits a full period.
  if (!rt.store.get("rediscover:last")) rt.store.set("rediscover:last", new Date().toISOString());

  while (!stopping) {
    try {
      const src = await connect();
      if (src) await pollOnce(rt, src);
    } catch (err) {
      log(pc.yellow(`poll failed: ${err instanceof Error ? err.message : err}`));
    }
    await maintenance(rt, log).catch((err) => log(pc.yellow(`maintenance failed: ${err instanceof Error ? err.message : err}`)));
    await new Promise((r) => setTimeout(r, source ? rt.settings().gmail.pollSeconds * 1000 : 3000));
  }
}
