import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import type { PlaybookStep, Project } from "../config/schema.js";
import type { ActionRecord, Email } from "../types.js";
import { emailAsData } from "../pipeline/prompts.js";
import { runClaudeCode } from "./claude-code.js";
import type { McpHub } from "./mcp-hub.js";

const run = promisify(execFile);

export interface ExecutionRequest {
  record: ActionRecord;
  step: PlaybookStep;
  project: Project | null;
  email: Email | null;
}

export interface Executor {
  run(req: ExecutionRequest): Promise<string>;
}

/** AppleScript string literal. */
const as = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function createReminder(title: string, notes: string): Promise<string> {
  if (platform() !== "darwin") return `Reminder (not on macOS, logged only): ${title}`;
  const script = `tell application "Reminders" to make new reminder with properties {name:${as(title)}, body:${as(notes)}}`;
  await run("osascript", ["-e", script]);
  return `Reminder created: ${title}`;
}

export class DefaultExecutor implements Executor {
  constructor(private readonly hub: McpHub) {}

  async run({ record, step, email }: ExecutionRequest): Promise<string> {
    switch (step.kind) {
      case "reminder": {
        const title = String(record.args.title ?? record.summary);
        const notes = email ? `${email.from}\n${email.subject}\nhttps://mail.google.com/mail/u/0/#all/${email.threadId}` : "";
        return createReminder(title, notes);
      }
      case "claude-code": {
        const task = String(record.args.task ?? record.summary);
        return runClaudeCode({
          repo: step.repo,
          baseBranch: step.baseBranch,
          actionId: record.id,
          title: record.summary,
          task,
          emailContext: email ? emailAsData(email) : "",
        });
      }
      case "mcp": {
        const args = { ...(step.defaults ?? {}), ...record.args };
        return this.hub.callTool(step.server, step.tool, args);
      }
    }
  }
}
