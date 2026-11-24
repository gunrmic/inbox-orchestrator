const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ibo", {
  call: (route, method, body) => ipcRenderer.invoke("ibo:call", route, method, body),
  open: (url) => ipcRenderer.invoke("ibo:open", url),
  refresh: () => ipcRenderer.invoke("ibo:refresh"),
  closeSetup: () => ipcRenderer.invoke("ibo:closeSetup"),
  agent: () => ipcRenderer.invoke("ibo:agent"),
  startAgent: () => ipcRenderer.invoke("ibo:startAgent"),
  stopAgent: () => ipcRenderer.invoke("ibo:stopAgent"),
  setAutoStart: (on) => ipcRenderer.invoke("ibo:autoStart", on),
  showLog: () => ipcRenderer.invoke("ibo:showLog"),
  openSetup: () => ipcRenderer.invoke("ibo:openSetup"),
  quit: () => ipcRenderer.invoke("ibo:quit"),
  update: () => ipcRenderer.invoke("ibo:update"),
  installUpdate: () => ipcRenderer.invoke("ibo:installUpdate"),
});
