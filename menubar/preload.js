const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ibo", {
  call: (route, method, body) => ipcRenderer.invoke("ibo:call", route, method, body),
  open: (url) => ipcRenderer.invoke("ibo:open", url),
  refresh: () => ipcRenderer.invoke("ibo:refresh"),
});
