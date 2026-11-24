import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { getSecret, setSecret } from "../util/secrets.js";

/** Read-only. The agent never sends or deletes mail, and never changes the calendar. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"];

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

/**
 * The project's shared Desktop OAuth client, so users only click "Sign in with Google".
 * For installed apps Google treats this secret as non-confidential (it ships in every
 * desktop binary); PKCE protects the sign-in. Tokens stay on the user's Mac.
 */
export const BUILTIN_CLIENT: ClientCreds = {
  client_id: "375193829689-6lptfjifqie265810bqgh56jjmms0dnj.apps.googleusercontent.com",
  client_secret: "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",
};

/** Precedence: env vars, then a client saved with `ibo setup gmail --client-json`, then the built-in one. */
export async function clientCredentials(): Promise<ClientCreds & { source: "env" | "saved" | "builtin" }> {
  const { IBO_GOOGLE_CLIENT_ID: id, IBO_GOOGLE_CLIENT_SECRET: secret } = process.env;
  if (id && secret) return { client_id: id, client_secret: secret, source: "env" };
  const stored = await getSecret("google-oauth-client");
  if (stored) return { ...(JSON.parse(stored) as ClientCreds), source: "saved" };
  return { ...BUILTIN_CLIENT, source: "builtin" };
}

async function loadClient(redirectUri?: string): Promise<OAuth2Client> {
  const c = await clientCredentials();
  return new OAuth2Client({ clientId: c.client_id, clientSecret: c.client_secret, redirectUri });
}

/** Loopback OAuth flow: opens the browser, catches the redirect on 127.0.0.1, stores the refresh token. */
export async function authorizeInteractive(opts: { onUrl?: (url: string) => void } = {}): Promise<void> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = await loadClient(redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

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
    if (opts.onUrl) opts.onUrl(url);
    else console.log(`\nOpen this URL to connect Gmail (read-only):\n${url}\n`);
    if (platform() === "darwin") execFile("open", [url]);
  });
  server.close();

  const { tokens } = await client.getToken({ code, codeVerifier });
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
