import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { OAuth2Client } from "google-auth-library";
import { getSecret, setSecret } from "../util/secrets.js";

/** Read-only. The agent never sends or deletes mail through Gmail. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

interface ClientCreds {
  client_id: string;
  client_secret: string;
}

/** Accepts the JSON downloaded from Google Cloud (either {installed:{...}} or flat). */
export function parseClientJson(json: string): ClientCreds {
  const raw = JSON.parse(json);
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error("Not a Google OAuth client JSON (missing client_id/client_secret).");
  return { client_id: c.client_id, client_secret: c.client_secret };
}

export async function saveClientCredentials(json: string): Promise<void> {
  const creds = parseClientJson(json);
  await setSecret("google-oauth-client", JSON.stringify(creds));
}

async function loadClient(redirectUri?: string): Promise<OAuth2Client> {
  const stored = await getSecret("google-oauth-client");
  if (!stored) throw new Error("No Google OAuth client. Run `ibo setup gmail` first.");
  const c = JSON.parse(stored) as ClientCreds;
  return new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret, redirectUri });
}

/** Loopback OAuth flow: opens the browser, catches the redirect on 127.0.0.1, stores the refresh token. */
export async function authorizeInteractive(): Promise<void> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = await loadClient(redirectUri);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES });

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google sign-in.")), 5 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/oauth2callback") return void res.end();
      const c = u.searchParams.get("code");
      res.setHeader("content-type", "text/html");
      res.end(c ? "<p>Signed in. You can close this tab.</p>" : "<p>Sign-in failed.</p>");
      clearTimeout(timer);
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "No code returned."));
    });
    console.log(`\nOpen this URL to connect Gmail (read-only):\n${url}\n`);
    if (platform() === "darwin") execFile("open", [url]);
  });
  server.close();

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Remove the app's access in your Google account and retry.");
  await setSecret("google-refresh-token", tokens.refresh_token);
}

export async function authorizedClient(): Promise<OAuth2Client> {
  const client = await loadClient();
  const refresh = await getSecret("google-refresh-token");
  if (!refresh) throw new Error("Gmail is not connected. Run `ibo setup gmail`.");
  client.setCredentials({ refresh_token: refresh });
  return client;
}
