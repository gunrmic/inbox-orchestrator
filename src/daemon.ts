import pc from "picocolors";
import { authorizedClient } from "./gmail/auth.js";
import { GmailSource } from "./gmail/client.js";
import { processEmail } from "./pipeline/index.js";
import { buildRuntime } from "./runtime.js";
import { buildApi } from "./server/api.js";

const ts = () => new Date().toISOString().slice(11, 19);

/** Foreground daemon: local API for the menu bar + Gmail polling loop. */
export async function startDaemon(): Promise<void> {
  const log = (s: string) => console.log(`${pc.dim(ts())} ${s}`);
  const rt = buildRuntime(log);
  const api = buildApi(rt);
  const port = rt.settings().server.port;
  await api.listen({ host: "127.0.0.1", port });
  log(`API on http://127.0.0.1:${port} (token in ~/.inbox-orchestrator/api-token)`);

  const gmail = new GmailSource(await authorizedClient());
  log(`Watching Gmail. ${rt.projects().length} projects mapped. Mode: ${rt.settings().mode}${rt.settings().killSwitch ? pc.red(" KILL SWITCH ON") : ""}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping...");
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

  while (!stopping) {
    rt.reload();
    try {
      const emails = await gmail.poll(rt.store, rt.settings().gmail.query);
      rt.store.set("gmail:lastPoll", new Date().toISOString());
      for (const email of emails) {
        try {
          await processEmail(rt, email);
        } catch (err) {
          log(pc.red(`error on "${email.subject}": ${err instanceof Error ? err.message : err}`));
          rt.store.audit("error", { emailId: email.id, error: String(err) });
        }
      }
    } catch (err) {
      log(pc.yellow(`poll failed: ${err instanceof Error ? err.message : err}`));
    }
    await new Promise((r) => setTimeout(r, rt.settings().gmail.pollSeconds * 1000));
  }
}
