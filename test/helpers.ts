import { Project, Settings } from "../src/config/schema.js";
import type { Email } from "../src/types.js";

export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...Settings.parse({}), ...patch });

export const project = (patch: Partial<Project> & { id: string }): Project =>
  Project.parse({ status: "live", ...patch });

export const email = (patch: Partial<Email> = {}): Email => ({
  id: "m1",
  threadId: "t1",
  from: "Jack <jack@coleven.com>",
  fromAddress: "jack@coleven.com",
  to: ["omer@example.com"],
  cc: [],
  subject: "Graph does not load when filtering by date",
  date: new Date().toISOString(),
  snippet: "",
  body: "Hi, the graph doesn't load when I filter by date. Can we talk tomorrow at 10?",
  attachments: [],
  auth: { spf: "pass", dkim: "pass" },
  ...patch,
});
