// Menu bar companion. Talks only to the local daemon on 127.0.0.1 with the token in
// ~/.inbox-orchestrator/api-token. Holds no credentials of its own.
const { app, ipcMain, Notification, shell, nativeImage } = require("electron");
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
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
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

let seen = new Set();
async function refreshBadge() {
  try {
    const pending = await call("/actions?status=pending");
    mb.tray.setTitle(pending.length ? ` ${pending.length}` : " ✓");
    for (const a of pending) {
      if (!seen.has(a.id) && Notification.isSupported()) {
        new Notification({ title: a.projectId ? `${a.projectId}: ${a.action}` : "New suggestion", body: a.summary }).show();
      }
    }
    seen = new Set(pending.map((a) => a.id));
  } catch {
    mb.tray.setTitle(" ⏸");
  }
}

mb.on("ready", () => {
  mb.tray.setTitle(" …");
  refreshBadge();
  setInterval(refreshBadge, 10_000);
});

ipcMain.handle("ibo:call", (_e, route, method, body) => call(route, method, body));
ipcMain.handle("ibo:open", (_e, url) => {
  if (typeof url === "string" && url.startsWith("https://mail.google.com/")) shell.openExternal(url);
});
ipcMain.handle("ibo:refresh", () => refreshBadge());

app.on("window-all-closed", (e) => e.preventDefault());
