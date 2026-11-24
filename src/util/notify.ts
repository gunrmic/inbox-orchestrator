import { execFile } from "node:child_process";
import { platform } from "node:os";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);

/** A plain macOS notification (no buttons). The menu bar app shows richer ones with Approve/Dismiss. */
export function notify(title: string, body: string): void {
  if (platform() !== "darwin" || process.env.IBO_NO_NOTIFY === "1") return;
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => undefined);
}
