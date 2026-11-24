import { DatabaseSync } from "node:sqlite";
import type { RiskLevel } from "../config/schema.js";
import type { ActionRecord, ActionStatus, Decision, Email } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_address TEXT,
  subject TEXT,
  received_at TEXT,
  project_id TEXT,
  filter_json TEXT,
  email_json TEXT,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  project_id TEXT,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  args_json TEXT NOT NULL,
  risk INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_status ON actions(status);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  email_id TEXT,
  action_id INTEGER,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_streaks (
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, action)
);
`;

const now = () => new Date().toISOString();

interface ActionRow {
  id: number;
  email_id: string;
  project_id: string | null;
  action: string;
  summary: string;
  args_json: string;
  risk: number;
  decision: string;
  reason: string;
  status: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: ActionRow): ActionRecord => ({
  id: r.id,
  emailId: r.email_id,
  projectId: r.project_id,
  action: r.action,
  summary: r.summary,
  args: JSON.parse(r.args_json),
  risk: r.risk as RiskLevel,
  decision: r.decision as Decision["kind"],
  reason: r.reason,
  status: r.status as ActionStatus,
  result: r.result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class Store {
  readonly db: DatabaseSync;

  /** Uses Node's built-in SQLite, so installing needs no native compilation. */
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  hasEmail(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM emails WHERE id = ?").get(id) !== undefined;
  }

  saveEmail(email: Email, projectId: string | null, filter: unknown): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO emails(id, thread_id, from_address, subject, received_at, project_id, filter_json, email_json, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        email.id,
        email.threadId,
        email.fromAddress,
        email.subject,
        email.date,
        projectId,
        JSON.stringify(filter),
        JSON.stringify(email),
        now(),
      );
  }

  getEmail(id: string): Email | null {
    const row = this.db.prepare("SELECT email_json FROM emails WHERE id = ?").get(id) as unknown as { email_json: string | null } | undefined;
    return row?.email_json ? (JSON.parse(row.email_json) as Email) : null;
  }

  addAction(input: {
    emailId: string;
    projectId: string | null;
    action: string;
    summary: string;
    args: Record<string, unknown>;
    decision: Decision;
  }): ActionRecord {
    const t = now();
    const status: ActionStatus =
      input.decision.kind === "execute" ? "executing" : input.decision.kind === "deny" ? "denied" : "pending";
    const info = this.db
      .prepare(
        `INSERT INTO actions(email_id, project_id, action, summary, args_json, risk, decision, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.emailId,
        input.projectId,
        input.action,
        input.summary,
        JSON.stringify(input.args),
        input.decision.risk,
        input.decision.kind,
        input.decision.reason,
        status,
        t,
        t,
      );
    return this.getAction(Number(info.lastInsertRowid))!;
  }

  getAction(id: number): ActionRecord | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as unknown as ActionRow | undefined;
    return row ? toRecord(row) : null;
  }

  listActions(status?: ActionStatus, limit = 100): ActionRecord[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM actions WHERE status = ? ORDER BY id DESC LIMIT ?").all(status, limit) as unknown as ActionRow[])
      : (this.db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(limit) as unknown as ActionRow[]);
    return rows.map(toRecord);
  }

  updateAction(id: number, patch: { status?: ActionStatus; result?: string; args?: Record<string, unknown> }): void {
    const current = this.getAction(id);
    if (!current) throw new Error(`No action ${id}`);
    this.db
      .prepare("UPDATE actions SET status = ?, result = ?, args_json = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.status ?? current.status,
        patch.result ?? current.result,
        JSON.stringify(patch.args ?? current.args),
        now(),
        id,
      );
  }

  audit(kind: string, detail: unknown, ids: { emailId?: string; actionId?: number } = {}): void {
    this.db
      .prepare("INSERT INTO audit(at, kind, email_id, action_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(now(), kind, ids.emailId ?? null, ids.actionId ?? null, JSON.stringify(detail));
  }

  recentAudit(limit = 50): { at: string; kind: string; detail: string }[] {
    return this.db.prepare("SELECT at, kind, detail FROM audit ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
      at: string;
      kind: string;
      detail: string;
    }[];
  }

  /** Approved without edits: streak + 1. Edited or rejected: reset. Returns the new streak. */
  recordApproval(projectId: string, action: string, edited: boolean): number {
    if (edited) {
      this.resetStreak(projectId, action);
      return 0;
    }
    this.db
      .prepare(
        `INSERT INTO approval_streaks(project_id, action, streak) VALUES (?, ?, 1)
         ON CONFLICT(project_id, action) DO UPDATE SET streak = streak + 1`,
      )
      .run(projectId, action);
    const row = this.db
      .prepare("SELECT streak FROM approval_streaks WHERE project_id = ? AND action = ?")
      .get(projectId, action) as unknown as { streak: number };
    return row.streak;
  }

  resetStreak(projectId: string, action: string): void {
    this.db
      .prepare(
        `INSERT INTO approval_streaks(project_id, action, streak) VALUES (?, ?, 0)
         ON CONFLICT(project_id, action) DO UPDATE SET streak = 0`,
      )
      .run(projectId, action);
  }

  close(): void {
    this.db.close();
  }
}
