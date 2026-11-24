// Menu bar companion. Talks only to the local daemon on 127.0.0.1 with the token in
// ~/.inbox-orchestrator/api-token. Holds no credentials of its own.
const { app, ipcMain, Notification, shell, nativeImage } = require("electron");
const { execFile, spawn } = require("node:child_process");
const { menubar } = require("menubar");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = process.env.IBO_HOME || path.join(os.homedir(), ".inbox-orchestrator");

function port() {
  try {
    const m = fs.readFileSync(path.join(HOME, "settings.yaml"), "utf8").match(/^\s+port:\s*(\d+)/m);
    return m ? Number(m[1]) : 47811;
  } catch {
    return 47811;
  }
}

function token() {
  try {
    return fs.readFileSync(path.join(HOME, "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function call(route, method = "GET", body) {
  const res = await fetch(`http://127.0.0.1:${port()}${route}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "x-ibo-client": "menubar", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const mb = menubar({
  index: `file://${path.join(__dirname, "index.html")}`,
  icon: nativeImage.createEmpty(),
  preloadWindow: true,
  showDockIcon: false,
  browserWindow: {
    width: 420,
    height: 600,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  },
});

let seen = null;
const live = new Set(); // keep notifications referenced so their buttons keep working

/**
 * One notification per new card. Levels 0-2 get "Do it" and "Dismiss" buttons, so most
 * cards never need the window. Dangerous actions (level 3) and "which project?" questions
 * only open the window.
 */
function notifyCard(a) {
  const quick = a.risk < 3 && !(a.args && a.args._assign);
  const n = new Notification({
    title: a.projectId ? `${a.projectId}: ${a.action}` : "New email to sort",
    body: a.summary,
    actions: quick ? [{ type: "button", text: "Do it" }, { type: "button", text: "Dismiss" }] : [],
  });
  live.add(n);
  const done = () => live.delete(n);
  n.on("action", async (_e, index) => {
    await call(`/actions/${a.id}/${index === 0 ? "approve" : "reject"}`, "POST").catch(() => undefined);
    done();
    refreshBadge();
  });
  n.on("click", () => {
    done();
    mb.showWindow();
  });
  n.on("close", done);
  n.show();
}

async function refreshBadge() {
  try {
    const [pending, status] = await Promise.all([call("/actions?status=pending"), call("/status")]);
    const count = pending.length + (status.suggestions || 0);
    mb.tray.setTitle(count ? ` ${count}` : " ✓");
    // The first look only records what is there, so opening the app does not replay old cards.
    if (seen && Notification.isSupported()) for (const a of pending) if (!seen.has(a.id)) notifyCard(a);
    seen = new Set(pending.map((a) => a.id));
  } catch {
    mb.tray.setTitle(" ⏸");
  }
}

// ---- Standalone app (.dmg): the daemon and CLI ship inside the app, run on Electron's Node.
const CLI = app.isPackaged ? path.join(process.resourcesPath, "cli", "dist", "cli.js") : null;
let daemon = null;

const nodeEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin` });

async function daemonUp() {
  try {
    await call("/status");
    return true;
  } catch {
    return false;
  }
}

/** A daemon may already run (launchd agent or `ibo start`); otherwise the app runs its own. */
async function ensureDaemon() {
  if (!CLI || (await daemonUp())) return;
  daemon = spawn(process.execPath, [CLI, "start"], { env: nodeEnv(), stdio: "ignore" });
  daemon.on("exit", () => (daemon = null));
}

/** First launch: setup asks questions, so it runs in a Terminal window. */
function openSetupInTerminal() {
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const cmd = `ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(CLI)} setup`;
  execFile("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", 'tell application "Terminal" to activate']);
}

function needsSetup() {
  return !fs.existsSync(path.join(HOME, "projects.yaml"));
}

mb.on("ready", async () => {
  mb.tray.setTitle(" …");
  if (CLI) {
    app.setLoginItemSettings({ openAtLogin: true });
    if (needsSetup()) openSetupInTerminal();
    await ensureDaemon();
    setInterval(ensureDaemon, 60_000);
  }
  refreshBadge();
  setInterval(refreshBadge, 10_000);
});

app.on("before-quit", () => daemon?.kill("SIGTERM"));

ipcMain.handle("ibo:call", (_e, route, method, body) => call(route, method, body));
ipcMain.handle("ibo:open", (_e, url) => {
  if (typeof url === "string" && url.startsWith("https://mail.google.com/")) shell.openExternal(url);
});
ipcMain.handle("ibo:refresh", () => refreshBadge());

app.on("window-all-closed", (e) => e.preventDefault());
