// Menu bar companion. Talks only to the local daemon on 127.0.0.1 with the token in
// ~/.inbox-orchestrator/api-token. Holds no credentials of its own.
const { app, BrowserWindow, dialog, ipcMain, Notification, shell, nativeImage } = require("electron");
const { execFile, spawn } = require("node:child_process");
const { menubar } = require("menubar");
const { autoUpdater } = require("electron-updater");
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

// ---- The agent (daemon). In the .dmg the CLI ships inside the app and runs on Electron's
// Node; in development it is the repo's build. A daemon started elsewhere (launchd agent,
// `ibo start`) is used as is.
const CLI = app.isPackaged ? path.join(process.resourcesPath, "cli", "dist", "cli.js") : path.join(__dirname, "..", "dist", "cli.js");
const LOG = path.join(HOME, "logs", "app-daemon.log");
const APP_PREFS = path.join(HOME, "app.json");
let daemon = null;
let lastExit = null;
let userPath = process.env.PATH || "";

function prefs() {
  try {
    return { autoStart: app.isPackaged, ...JSON.parse(fs.readFileSync(APP_PREFS, "utf8")) };
  } catch {
    // The installed app keeps its agent running; a development run never starts one by itself.
    return { autoStart: app.isPackaged };
  }
}
function savePrefs(p) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(APP_PREFS, JSON.stringify({ ...prefs(), ...p }, null, 2));
}

/** Apps opened from Finder get a bare PATH; the agent needs the user's (claude, git, npx, ollama). */
function loadLoginPath() {
  if (process.platform !== "darwin") return;
  execFile(process.env.SHELL || "/bin/zsh", ["-ilc", "printf %s \"$PATH\""], { timeout: 5000 }, (err, out) => {
    if (!err && out) userPath = out.trim().split("\n").pop();
  });
}
const nodeEnv = () => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  PATH: [userPath, "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/usr/bin", "/bin"].join(":"),
});

async function daemonUp() {
  try {
    await call("/status");
    return true;
  } catch {
    return false;
  }
}

function logTail(lines = 40) {
  try {
    return fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function startAgent() {
  if (daemon || !fs.existsSync(CLI)) return false;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, "a");
  fs.writeSync(out, `\n--- started by the app ${new Date().toISOString()} ---\n`);
  daemon = spawn(process.execPath, [CLI, "start"], { env: nodeEnv(), stdio: ["ignore", out, out] });
  daemon.on("exit", (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() };
    daemon = null;
    refreshBadge();
  });
  return true;
}

function stopAgent() {
  if (daemon) daemon.kill("SIGTERM");
}

/** Keeps the agent running unless the user stopped it. */
async function ensureDaemon() {
  if (!prefs().autoStart || (await daemonUp())) return;
  startAgent();
}

async function agentState() {
  const up = await daemonUp();
  return {
    running: up,
    startedByApp: !!daemon,
    canStart: fs.existsSync(CLI),
    autoStart: prefs().autoStart,
    lastExit,
    log: up ? "" : logTail(),
    logPath: LOG,
  };
}

// ---- First run: a setup window in the app itself. No Terminal.
let setupWin = null;

function openSetup() {
  if (setupWin) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 760,
    height: 640,
    title: "Set up Inbox Orchestrator",
    show: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  setupWin.loadFile(path.join(__dirname, "setup.html"));
  setupWin.on("closed", () => (setupWin = null));
}

/** Setup is needed until the user finished the window, unless projects were mapped from the terminal. */
async function checkSetup() {
  try {
    const s = await call("/setup/status");
    if (!s.done && s.projects === 0) openSetup();
    return true;
  } catch {
    return false;
  }
}

// ---- Updates: the signed app checks GitHub Releases, downloads in the background and
// offers "Restart to update" in the window. The agent inside the app updates with it.
let updateReady = null;
function setupUpdates() {
  if (!app.isPackaged || process.env.IBO_NO_AUTO_UPDATE === "1") return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version;
    if (Notification.isSupported()) new Notification({ title: "Inbox Orchestrator", body: `Version ${info.version} is ready. Restart to update.` }).show();
  });
  autoUpdater.on("error", () => undefined);
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 10_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/** Running from the .dmg or Downloads breaks updates and login items: offer to move it. */
async function offerMoveToApplications() {
  if (!app.isPackaged || process.platform !== "darwin" || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move Inbox Orchestrator to your Applications folder?",
    detail: "It needs to live in Applications to start at login and to update itself.",
  });
  if (response === 0) {
    try {
      app.moveToApplicationsFolder();
    } catch (err) {
      dialog.showErrorBox("Could not move the app", String(err && err.message ? err.message : err));
    }
  }
}

mb.on("ready", async () => {
  mb.tray.setTitle(" …");
  loadLoginPath();
  await offerMoveToApplications();
  setupUpdates();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: prefs().autoStart });
  await new Promise((r) => setTimeout(r, 300));
  await ensureDaemon();
  setInterval(ensureDaemon, 60_000);
  // The daemon needs a moment after starting; keep trying in the background until it answers.
  void (async () => {
    for (let i = 0; i < 30 && !(await checkSetup()); i++) await new Promise((r) => setTimeout(r, 1000));
  })();
  refreshBadge();
  setInterval(refreshBadge, 10_000);
});

app.on("before-quit", () => stopAgent());

ipcMain.handle("ibo:call", (_e, route, method, body) => call(route, method, body));
// Only links the app itself shows: Gmail threads, Google sign-in, and two download pages.
const ALLOWED = ["https://mail.google.com/", "https://accounts.google.com/", "https://ollama.com/", "https://docs.claude.com/"];
ipcMain.handle("ibo:open", (_e, url) => {
  if (typeof url === "string" && ALLOWED.some((p) => url.startsWith(p))) shell.openExternal(url);
});
ipcMain.handle("ibo:closeSetup", () => setupWin?.close());
ipcMain.handle("ibo:agent", () => agentState());
ipcMain.handle("ibo:startAgent", async () => {
  savePrefs({ autoStart: true });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  const started = startAgent();
  for (let i = 0; i < 40 && !(await daemonUp()); i++) await new Promise((r) => setTimeout(r, 250));
  refreshBadge();
  return { started, ...(await agentState()) };
});
ipcMain.handle("ibo:stopAgent", () => {
  savePrefs({ autoStart: false });
  stopAgent();
  return true;
});
ipcMain.handle("ibo:autoStart", (_e, on) => {
  savePrefs({ autoStart: !!on });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on });
  return prefs().autoStart;
});
ipcMain.handle("ibo:showLog", () => shell.openPath(LOG));
ipcMain.handle("ibo:openSetup", () => openSetup());
ipcMain.handle("ibo:quit", () => app.quit());
ipcMain.handle("ibo:update", () => ({ ready: updateReady, current: app.getVersion() }));
ipcMain.handle("ibo:installUpdate", () => {
  stopAgent();
  autoUpdater.quitAndInstall();
});
ipcMain.handle("ibo:refresh", () => refreshBadge());

app.on("window-all-closed", (e) => e.preventDefault());
