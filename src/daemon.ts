import pc from "picocolors";
import { authorizedClient } from "./gmail/auth.js";
import { GmailSource } from "./gmail/client.js";
import { FixtureSource, type EmailSource } from "./gmail/source.js";
import { processEmail } from "./pipeline/index.js";
import { buildRuntime, type Runtime } from "./runtime.js";
import { buildApi } from "./server/api.js";

const ts = () => new Date().toISOString().slice(11, 19);

/** One polling cycle: reload config, fetch new mail, run each email through the pipeline. */
export async function pollOnce(rt: Runtime, source: EmailSource): Promise<number> {
  rt.reload();
  const log = rt.log ?? (() => {});
  const emails = await source.poll(rt.store, rt.settings().gmail.query);
  rt.store.set("gmail:lastPoll", new Date().toISOString());
  for (const email of emails) {
    try {
      await processEmail(rt, email);
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

/** Foreground daemon: local API for the menu bar + polling loop. */
export async function startDaemon(): Promise<void> {
  const log = (s: string) => console.log(`${pc.dim(ts())} ${s}`);
  const rt = buildRuntime(log);
  const api = buildApi(rt);
  const port = rt.settings().server.port;
  await api.listen({ host: "127.0.0.1", port });
  log(`API on http://127.0.0.1:${port} (token in ~/.inbox-orchestrator/api-token)`);

  const source = await emailSource();
  log(
    `Watching ${process.env.IBO_TEST_INBOX ? "test inbox" : "Gmail"}. ${rt.projects().length} projects mapped. Mode: ${rt.settings().mode}${rt.settings().killSwitch ? pc.red(" KILL SWITCH ON") : ""}`,
  );

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
    try {
      await pollOnce(rt, source);
    } catch (err) {
      log(pc.yellow(`poll failed: ${err instanceof Error ? err.message : err}`));
    }
    await new Promise((r) => setTimeout(r, rt.settings().gmail.pollSeconds * 1000));
  }
}
