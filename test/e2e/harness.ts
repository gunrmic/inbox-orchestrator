import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = join(ROOT, "dist", "cli.js");
export const MCP_SERVER = join(ROOT, "test", "fixtures", "mcp-server.mjs");

export interface FakeServer {
  url: string;
  requests: { path: string; body: any }[];
  close(): Promise<void>;
}

async function listen(handler: (path: string, body: any) => { status?: number; json: unknown }): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = (req.url ?? "/").split("?")[0];
      requests.push({ path, body });
      const out = handler(path, body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

export type Planner = (body: any) => unknown;

/**
 * Speaks enough of the Anthropic Messages API for the SDK: answers every forced tool call
 * with an object chosen by the tool name.
 */
export function fakeAnthropic(answers: Record<string, Planner>): Promise<FakeServer> {
  return listen((path, body) => {
    if (path !== "/v1/messages") return { status: 404, json: { error: "not found" } };
    const name: string = body.tool_choice?.name ?? body.tools?.[0]?.name;
    const answer = answers[name];
    if (!answer) return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: `no fake for ${name}` } } };
    return {
      json: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "tool_use", id: "toolu_fake", name, input: answer(body) }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    };
  });
}

/** Speaks enough of the Ollama API: /api/tags and /api/chat with a JSON answer. */
export function fakeOllama(answer: (body: any) => unknown): Promise<FakeServer> {
  return listen((path, body) => {
    if (path === "/api/tags") return { json: { models: [{ name: "qwen3:8b" }] } };
    if (path === "/api/chat") return { json: { message: { role: "assistant", content: JSON.stringify(answer(body)) } } };
    return { status: 404, json: {} };
  });
}

export interface Env {
  home: string;
  iboHome: string;
  vars: Record<string, string>;
}

/** A throwaway HOME and IBO_HOME, file secrets backend, no real API keys. */
export function makeEnv(extra: Record<string, string> = {}): Env {
  const home = mkdtempSync(join(tmpdir(), "ibo-e2e-home-"));
  const iboHome = join(home, ".inbox-orchestrator");
  mkdirSync(iboHome, { recursive: true });
  const vars: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    IBO_HOME: iboHome,
    IBO_SECRETS_BACKEND: "file",
    IBO_CLAUDE_BIN: join(home, "no-claude"),
    IBO_NO_AUTO_UPDATE: "1",
    IBO_NO_NOTIFY: "1",
    NO_COLOR: "1",
    ...extra,
  };
  return { home, iboHome, vars };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI asynchronously (fake servers live in this process and must keep answering). */
export function ibo(env: Env, args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env.vars, cwd: env.home });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface Daemon {
  child: ChildProcess;
  output: () => string;
  stop(): Promise<number | null>;
}

/** Starts `ibo start` and waits until it watches the inbox. */
export async function startDaemon(env: Env): Promise<Daemon> {
  const child = spawn(process.execPath, [CLI, "start"], { env: env.vars, cwd: env.home });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 20_000;
  while (!out.includes("Watching")) {
    if (child.exitCode !== null) throw new Error(`daemon exited early:\n${out}`);
    if (Date.now() > deadline) throw new Error(`daemon did not start:\n${out}`);
    await sleep(100);
  }
  return {
    child,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.on("close", (code) => resolve(code));
        child.kill("SIGTERM");
      }),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(150);
  }
}

export function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function readLines(file: string): any[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** A free TCP port for the daemon's API. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

export const jackEmail = (patch: Record<string, unknown> = {}) => ({
  id: "jack-1",
  threadId: "t-1",
  from: "Jack <jack@coleven.com>",
  fromAddress: "jack@coleven.com",
  to: ["omer@example.com"],
  cc: [],
  subject: "Graph does not load when filtering by date",
  date: new Date().toISOString(),
  snippet: "",
  body: "The graph is empty when I filter by date. Please open a ticket.",
  attachments: [],
  auth: { spf: "pass", dkim: "pass" },
  ...patch,
});
