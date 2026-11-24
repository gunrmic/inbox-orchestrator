import type { Email } from "../types.js";

interface Part {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: Part[] | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
}

export interface RawMessage {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: Part | null;
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(part: Part, out: { plain: string[]; html: string[]; attachments: Email["attachments"] }) {
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({ filename: part.filename, mimeType: part.mimeType ?? "", size: part.body.size ?? 0 });
  } else if (part.mimeType === "text/plain" && part.body?.data) {
    out.plain.push(decode(part.body.data));
  } else if (part.mimeType === "text/html" && part.body?.data) {
    out.html.push(decode(part.body.data));
  }
  for (const p of part.parts ?? []) walk(p, out);
}

/** "Jack <jack@coleven.com>" -> "jack@coleven.com" */
export function addressOf(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

const splitAddresses = (v: string) => (v ? v.split(",").map((s) => addressOf(s)).filter(Boolean) : []);

export function parseAuthResults(value: string): Email["auth"] {
  const pick = (k: string): "pass" | "fail" | "unknown" => {
    const m = value.match(new RegExp(`${k}=(\\w+)`, "i"));
    if (!m) return "unknown";
    return m[1].toLowerCase() === "pass" ? "pass" : "fail";
  };
  return { spf: pick("spf"), dkim: pick("dkim") };
}

export function parseMessage(msg: RawMessage): Email {
  const headers = new Map<string, string>();
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value && !headers.has(h.name.toLowerCase())) headers.set(h.name.toLowerCase(), h.value);
  }
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as Email["attachments"] };
  if (msg.payload) walk(msg.payload, out);
  const body = out.plain.length ? out.plain.join("\n") : stripHtml(out.html.join("\n"));
  const from = headers.get("from") ?? "";
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from,
    fromAddress: addressOf(from),
    to: splitAddresses(headers.get("to") ?? ""),
    cc: splitAddresses(headers.get("cc") ?? ""),
    subject: headers.get("subject") ?? "(no subject)",
    date: headers.get("date") ?? (msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : ""),
    snippet: msg.snippet ?? "",
    body,
    attachments: out.attachments,
    auth: parseAuthResults(headers.get("authentication-results") ?? ""),
  };
}
